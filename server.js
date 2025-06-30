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

// Official UNO deck (no stacking, no house rules, all actions as per official)
function drawCards(n = 1) {
  const colors = ['Red', 'Green', 'Blue', 'Yellow'];
  const values = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
  const cards = [];
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.15) {
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

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  // --- WAITING PAGE: New player joins (host or guest)
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
        previousTopCardColor: null // for +4 challenge (not implemented, but future ready)
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

  // --- GAME PAGE: Player reconnects or joins game.html
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

  // --- Official UNO: Only play if valid (color/value/Wild)
  socket.on('playCard', (card) => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player) return;

    // Only allow if it's this player's turn
    if (room.players[room.turnIndex]?.name !== playerName) return;

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

    // Save for +4 challenge (not implemented, but correct for future)
    room.previousTopCardColor = top.color;

    // Handle Wild card color selection
    let playedCard = { ...card };
    if (card.color === 'Wild') {
      // In official UNO, player must choose a color (front-end: send chosenColor)
      if (!card.chosenColor) {
        // fallback: assign random color
        playedCard.color = ['Red', 'Green', 'Blue', 'Yellow'][Math.floor(Math.random() * 4)];
      } else {
        playedCard.color = card.chosenColor;
      }
    }

    room.topCard = playedCard;

    // --- Card effect ---
    let skipNext = false;

    if (card.value === 'Reverse') {
      if (room.players.length === 2) {
        // 2 player: Reverse acts as Skip
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

    // --- TMR Call (UNO call) ---
    if (player.hand.length === 1) {
      player.calledTMR = false;
      io.in(currentRoom).emit('tmr-alert', { name: player.name }); // Frontend: show TMR button
    }

    // --- Win check ---
    if (player.hand.length === 0) {
      io.in(currentRoom).emit('gameOver', { winner: player.name });
      return;
    }

    // Next turn announce
    room.players.forEach((p, i) => {
      io.to(p.id).emit('yourTurn', i === room.turnIndex);
    });

    sendUpdate(currentRoom);
  });

  // Draw card: If playable, player may play it immediately (classic rule: must play if possible)
  socket.on('drawCard', () => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player) return;

    if (room.players[room.turnIndex]?.name !== playerName) return; // Only current player can draw

    const card = drawCards(1)[0];
    player.hand.push(card);
    socket.emit('updateHand', player.hand);

    // Check if the drawn card is playable
    const top = room.topCard;
    const canPlay =
      card.color === 'Wild' ||
      card.color === top.color ||
      card.value === top.value;

    if (canPlay) {
      // Frontend: prompt to play the drawn card or keep (must play if possible in official rules)
      socket.emit('canPlayDrawnCard', card);
    } else {
      // Turn passes
      room.turnIndex = nextTurnIndex(room, 1);
      room.players.forEach((p, i) => {
        io.to(p.id).emit('yourTurn', i === room.turnIndex);
      });
      sendUpdate(currentRoom);
    }
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
      offender.hand.push(...drawCards(2)); // Penalty
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
              }
            }
            delete disconnectTimers[socket.id];
          }, 45000); // 45 seconds
        }
      }
    }
  });

  function nextTurnIndex(room, skip = 1) {
    const len = room.players.length;
    return (room.turnIndex + skip * room.direction + len) % len;
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
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
