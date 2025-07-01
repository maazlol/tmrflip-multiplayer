const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const disconnectTimers = {}; // socket.id -> timeoutId

app.get('/getName', (req, res) => {
  const name = 'Player' + Math.floor(Math.random() * 10000);
  res.json({ name });
});

// --- 7 Special Cards Definitions ---
const SPECIALS = [
  { value: "Bomb", color: "Black", type: "Special", special: "bomb" },
  { value: "Swap", color: "Black", type: "Special", special: "swap" },
  { value: "Peek", color: "Black", type: "Special", special: "peek" },
  { value: "Steal", color: "Black", type: "Special", special: "steal" },
  { value: "Skip All", color: "Black", type: "Special", special: "skipall" },
  { value: "Color Lock", color: "Black", type: "Special", special: "colorlock" },
  { value: "Reverse+", color: "Black", type: "Special", special: "reverseattack" }
];

function drawCards(n = 1, includeSpecials = true) {
  const colors = ['Red', 'Green', 'Blue', 'Yellow'];
  const values = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
  const cards = [];
  for (let i = 0; i < n; i++) {
    // 10% chance for special cards
    if (includeSpecials && Math.random() < 0.10) {
      cards.push({ ...SPECIALS[Math.floor(Math.random() * SPECIALS.length)] });
    } else if (Math.random() < 0.15) {
      const wildCard = Math.random() < 0.5 ? 'Wild' : '+4';
      cards.push({ color: 'Wild', value: wildCard });
    } else {
      const color = colors[Math.floor(Math.random() * colors.length)];
      const value = values[Math.floor(Math.random() * values.length)];
      cards.push({ color, value });
    }
  }
  return cards;
}

// --- Helper for Color Lock ---
const colorLocks = {}; // roomCode -> { color: "Red", turns: 0 }

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  socket.on('join-game', ({ name, code, isHost }) => {
    if (!rooms[code]) {
      if (!isHost) return;
      rooms[code] = {
        host: name,
        players: [],
        gameStarted: false,
        topCard: null,
        turnIndex: 0,
        direction: 1,
        previousTopCardColor: null
      };
    }

    const room = rooms[code];
    if (room.players.find(p => p.name === name)) {
      socket.emit('name-taken');
      return;
    }

    playerName = name;
    currentRoom = code;
    socket.join(code);
    room.players.push({ name, id: socket.id, hand: [], ready: false, connected: true, calledTMR: false });

    const allNames = room.players.map(p => p.name);
    io.in(code).emit('player-list', allNames);
    io.in(code).emit('chat-message', { name: 'System', message: `${name} joined.` });
  });

  socket.on('chat-message', ({ code, name, message }) => {
    io.in(code).emit('chat-message', { name, message });
  });

  socket.on('start-game', ({ code, name }) => {
    const room = rooms[code];
    if (!room || room.host !== name || room.players.length < 2) return;

    room.players.forEach(p => {
      p.hand = drawCards(7);
      p.ready = false;
      p.calledTMR = false;
    });
    room.topCard = drawCards(1)[0];
    room.turnIndex = 0;
    room.direction = 1;
    room.gameStarted = true;

    room.players.forEach(p => {
      io.to(p.id).emit('deal-hand');
    });
  });

  socket.on('joinGame', (name) => {
    const code = socket.handshake.headers.referer.split('?code=')[1]?.split('&')[0];
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.name === name);

    if (player) {
      if (player.id !== socket.id) {
        if (disconnectTimers[player.id]) {
          clearTimeout(disconnectTimers[player.id]);
          delete disconnectTimers[player.id];
        }
        player.id = socket.id;
      }
      player.connected = true;
      playerName = name;
      currentRoom = code;
      socket.join(code);

      if (!player.hand || player.hand.length === 0) {
        player.hand = drawCards(7);
      }
      socket.emit('updateHand', player.hand);

      sendUpdate(code);
    } else {
      socket.emit('joinFailed', 'Player not found in this room.');
    }
  });

  socket.on('playerReady', () => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (player) player.ready = true;

    sendUpdate(currentRoom);

    if (
      room &&
      !room.gameStarted &&
      room.players.length >= 2 &&
      room.players.every(p => p.ready)
    ) {
      room.gameStarted = true;
      room.topCard = drawCards(1)[0];
      room.turnIndex = 0;
      io.in(currentRoom).emit('startGame');
      io.in(currentRoom).emit('updateTopCard', room.topCard);

      room.players.forEach((p, i) => {
        io.to(p.id).emit('updateHand', p.hand);
        io.to(p.id).emit('yourTurn', i === room.turnIndex);
      });

      sendUpdate(currentRoom);
    }
  });

  socket.on('playCard', (card) => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player) return;

    if (room.players[room.turnIndex]?.name !== playerName) return;

    // Color lock: restrict play if active
    if (colorLocks[currentRoom] && colorLocks[currentRoom].turns > 0) {
      if (card.color !== colorLocks[currentRoom].color && card.color !== "Wild" && !card.type) {
        socket.emit('chat-message', { name: 'System', message: `Color Lock active! Only ${colorLocks[currentRoom].color} cards or Wilds allowed.` });
        return;
      }
    }

    // --- SPECIAL CARDS HANDLING ---
    if (card.type === "Special") {
      // Remove from hand (find by .special property)
      const idx = player.hand.findIndex(c => c.type === "Special" && c.special === card.special);
      if (idx === -1) return;
      player.hand.splice(idx, 1);
      room.topCard = { ...card };

      // --- Special Card Effects ---
      switch (card.special) {
        case "bomb": {
          // Next player discards their hand
          const targetIdx = getNextPlayerIndex(room);
          const targetPlayer = room.players[targetIdx];
          if (targetPlayer) {
            targetPlayer.hand = [];
            io.in(currentRoom).emit("special-anim", { type: "bomb", target: targetPlayer.name });
          }
          room.turnIndex = nextTurnIndex(room, 1);
          break;
        }
        case "swap": {
          // Ask the player to choose a target
          const others = room.players.filter(p => p.name !== playerName).map(p => p.name);
          socket.emit("chooseSwapTarget", { players: others });
          // Wait for client to emit 'swapTargetChosen'
          socket.once("swapTargetChosen", ({ target }) => {
            const targetP = room.players.find(p => p.name === target);
            if (targetP) {
              // Swap hands
              const temp = player.hand;
              player.hand = targetP.hand;
              targetP.hand = temp;
              io.in(currentRoom).emit("special-anim", { type: "swap", target: targetP.name });
              io.to(player.id).emit("updateHand", player.hand);
              io.to(targetP.id).emit("updateHand", targetP.hand);
            }
            afterSpecialTurn(room, player, currentRoom);
          });
          return; // Wait for swap to complete before proceeding
        }
        case "peek": {
          const others = room.players.filter(p => p.name !== playerName).map(p => p.name);
          socket.emit("choosePeekTarget", { players: others });
          socket.once("peekTargetChosen", ({ target }) => {
            const targetP = room.players.find(p => p.name === target);
            if (targetP) {
              socket.emit("peekHand", { name: targetP.name, hand: targetP.hand });
              io.in(currentRoom).emit("special-anim", { type: "peek", target: targetP.name });
            }
            afterSpecialTurn(room, player, currentRoom);
          });
          return;
        }
        case "steal": {
          const others = room.players.filter(p => p.name !== playerName && p.hand.length > 0).map(p => p.name);
          socket.emit("chooseStealTarget", { players: others });
          socket.once("stealTargetChosen", ({ target }) => {
            const targetP = room.players.find(p => p.name === target);
            if (targetP && targetP.hand.length > 0) {
              const randIdx = Math.floor(Math.random() * targetP.hand.length);
              const stolen = targetP.hand.splice(randIdx, 1)[0];
              player.hand.push(stolen);
              io.in(currentRoom).emit("special-anim", { type: "steal", target: targetP.name });
              io.to(player.id).emit("updateHand", player.hand);
              io.to(targetP.id).emit("updateHand", targetP.hand);
            }
            afterSpecialTurn(room, player, currentRoom);
          });
          return;
        }
        case "skipall": {
          // Everyone skips, current player plays again
          io.in(currentRoom).emit("special-anim", { type: "skipall" });
          // Don't advance turn!
          break;
        }
        case "colorlock": {
          // Only chosen color (or Red if not set) for next 2 turns
          const chosenColor = card.chosenColor || "Red";
          colorLocks[currentRoom] = { color: chosenColor, turns: 2 };
          io.in(currentRoom).emit("special-anim", { type: "colorlock", color: chosenColor });
          room.turnIndex = nextTurnIndex(room, 1);
          break;
        }
        case "reverseattack": {
          room.direction *= -1;
          // Next player draws 2 cards
          const targetIdx = getNextPlayerIndex(room);
          const targetPlayer = room.players[targetIdx];
          if (targetPlayer) {
            targetPlayer.hand.push(...drawCards(2));
            io.in(currentRoom).emit("special-anim", { type: "reverseattack", target: targetPlayer.name });
            io.to(targetPlayer.id).emit("updateHand", targetPlayer.hand);
          }
          room.turnIndex = nextTurnIndex(room, 1);
          break;
        }
      }

      io.in(currentRoom).emit('updateTopCard', card);
      io.to(player.id).emit('updateHand', player.hand);

      // Win check after special card
      if (player.hand.length === 0) {
        io.in(currentRoom).emit('gameOver', { winner: player.name });
        return;
      }
      room.players.forEach((p, i) => {
        io.to(p.id).emit('yourTurn', i === room.turnIndex);
      });
      sendUpdate(currentRoom);
      // Color lock decrement
      handleColorLockDecrement(currentRoom);
      return;
    }

    // --- REGULAR UNO LOGIC ---
    const top = room.topCard;
    const isValid =
      card.color === 'Wild' ||
      card.color === top.color ||
      card.value === top.value;

    if (!isValid) {
      socket.emit('chat-message', { name: 'System', message: 'Invalid card! Must match color or value or be Wild.' });
      return;
    }

    // Remove the card from hand
    const index = player.hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (index === -1) return; // Not found in hand
    player.hand.splice(index, 1);

    room.previousTopCardColor = top.color;

    // Handle Wild card color selection
    let playedCard = { ...card };
    if (card.color === 'Wild') {
      if (!card.chosenColor) {
        playedCard.color = ['Red', 'Green', 'Blue', 'Yellow'][Math.floor(Math.random() * 4)];
      } else {
        playedCard.color = card.chosenColor;
      }
    }

    room.topCard = playedCard;

    let skipNext = false;
    if (card.value === 'Reverse') {
      if (room.players.length === 2) {
        skipNext = true;
      } else {
        room.direction *= -1;
      }
    }

    if (card.value === 'Skip' || skipNext) {
      room.turnIndex = nextTurnIndex(room, 2);
    } else if (card.value === '+2') {
      const target = getPlayerAtOffset(room, 1);
      if (target) target.hand.push(...drawCards(2));
      room.turnIndex = nextTurnIndex(room, 2);
    } else if (card.value === '+4') {
      const target = getPlayerAtOffset(room, 1);
      if (target) target.hand.push(...drawCards(4));
      room.turnIndex = nextTurnIndex(room, 2);
    } else {
      room.turnIndex = nextTurnIndex(room, 1);
    }

    io.in(currentRoom).emit('updateTopCard', playedCard);
    socket.emit('updateHand', player.hand);

    // TMR Call (UNO call)
    if (player.hand.length === 1) {
      player.calledTMR = false;
      io.in(currentRoom).emit('tmr-alert', { name: player.name });
    }

    // Win check
    if (player.hand.length === 0) {
      io.in(currentRoom).emit('gameOver', { winner: player.name });
      return;
    }

    room.players.forEach((p, i) => {
      io.to(p.id).emit('yourTurn', i === room.turnIndex);
    });

    sendUpdate(currentRoom);
    handleColorLockDecrement(currentRoom);
  });

  // Helper for after async special card turns (swap, peek, steal)
  function afterSpecialTurn(room, player, currentRoom) {
    io.in(currentRoom).emit('updateTopCard', room.topCard);
    io.to(player.id).emit('updateHand', player.hand);
    // Win check
    if (player.hand.length === 0) {
      io.in(currentRoom).emit('gameOver', { winner: player.name });
      return;
    }
    room.turnIndex = nextTurnIndex(room, 1);
    room.players.forEach((p, i) => {
      io.to(p.id).emit('yourTurn', i === room.turnIndex);
    });
    sendUpdate(currentRoom);
    handleColorLockDecrement(currentRoom);
  }

  socket.on('swapTargetChosen', data => socket.emit('swapTargetChosen', data));
  socket.on('peekTargetChosen', data => socket.emit('peekTargetChosen', data));
  socket.on('stealTargetChosen', data => socket.emit('stealTargetChosen', data));

  // Draw card: If playable, player may play it immediately (classic rule: must play if possible)
  socket.on('drawCard', () => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player) return;

    if (room.players[room.turnIndex]?.name !== playerName) return;

    const card = drawCards(1)[0];
    player.hand.push(card);
    socket.emit('updateHand', player.hand);

    const top = room.topCard;
    const canPlay =
      card.color === 'Wild' ||
      card.color === top.color ||
      card.value === top.value;

    if (canPlay) {
      socket.emit('canPlayDrawnCard', card);
    } else {
      room.turnIndex = nextTurnIndex(room, 1);
      room.players.forEach((p, i) => {
        io.to(p.id).emit('yourTurn', i === room.turnIndex);
      });
      sendUpdate(currentRoom);
    }
    handleColorLockDecrement(currentRoom);
  });

  // --- TMR Call (UNO call) ---
  socket.on('callTMR', () => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (player && player.hand.length === 1) {
      player.calledTMR = true;
      io.in(currentRoom).emit('chat-message', { name: 'System', message: `${player.name} called TMR!` });
    }
  });

  // --- Catch TMR (UNO) ---
  socket.on('catchTMR', (offenderName) => {
    const room = rooms[currentRoom];
    const offender = room?.players.find(p => p.name === offenderName);
    if (offender && offender.hand.length === 1 && !offender.calledTMR) {
      offender.hand.push(...drawCards(2));
      io.in(currentRoom).emit('chat-message', { name: 'System', message: `${offender.name} did not call TMR! +2 penalty.` });
      offender.calledTMR = true;
      sendUpdate(currentRoom);
    }
  });

  socket.on('disconnect', () => {
    if (currentRoom && playerName) {
      const room = rooms[currentRoom];
      const player = room?.players.find(p => p.name === playerName);
      if (player) {
        player.connected = false;
        if (!disconnectTimers[socket.id]) {
          disconnectTimers[socket.id] = setTimeout(() => {
            const idx = room.players.findIndex(p => p.name === playerName);
            if (idx !== -1 && room.players[idx].connected === false) {
              room.players.splice(idx, 1);
              sendUpdate(currentRoom);
              if (room.players.length === 0) {
                delete rooms[currentRoom];
                delete colorLocks[currentRoom];
              }
            }
            delete disconnectTimers[socket.id];
          }, 45000);
        }
      }
    }
  });

  function nextTurnIndex(room, skip = 1) {
    const len = room.players.length;
    return (room.turnIndex + skip * room.direction + len) % len;
  }
  function getNextPlayerIndex(room) {
    const len = room.players.length;
    return (room.turnIndex + 1 * room.direction + len) % len;
  }
  function getPlayerAtOffset(room, offset) {
    const idx = (room.turnIndex + offset * room.direction + room.players.length) % room.players.length;
    return room.players[idx];
  }
  function sendUpdate(code) {
    const room = rooms[code];
    if (!room) return;
    const players = room.players.map(p => p.name);
    const handCounts = room.players.map(p => p.hand.length);
    const currentPlayer = room.players[room.turnIndex]?.name;
    const readyCounts = {
      ready: room.players.filter(p => p.ready).length,
      total: room.players.length
    };
    io.in(code).emit('updatePlayers', { players, handCounts, currentPlayer, readyCounts });
  }
  function handleColorLockDecrement(roomCode) {
    if (colorLocks[roomCode]) {
      colorLocks[roomCode].turns--;
      if (colorLocks[roomCode].turns <= 0) delete colorLocks[roomCode];
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
