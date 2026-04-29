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
const disconnectTimers = {};

// ──────────────────────────────────────────────
// Card generation
// ──────────────────────────────────────────────
const COLORS = ['Red', 'Green', 'Blue', 'Yellow'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
const SPECIALS = [
  { value:'Bomb',       color:'Black', type:'Special', special:'bomb'          },
  { value:'Swap',       color:'Black', type:'Special', special:'swap'          },
  { value:'Peek',       color:'Black', type:'Special', special:'peek'          },
  { value:'Steal',      color:'Black', type:'Special', special:'steal'         },
  { value:'Skip All',   color:'Black', type:'Special', special:'skipall'       },
  { value:'Color Lock', color:'Black', type:'Special', special:'colorlock'     },
  { value:'Reverse+',   color:'Black', type:'Special', special:'reverseattack' },
];

function drawCards(n = 1) {
  const cards = [];
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    if (r < 0.08) {
      cards.push({ ...SPECIALS[Math.floor(Math.random() * SPECIALS.length)] });
    } else if (r < 0.20) {
      cards.push({ color:'Wild', value: Math.random() < 0.5 ? 'Wild' : '+4' });
    } else {
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const value = VALUES[Math.floor(Math.random() * VALUES.length)];
      cards.push({ color, value });
    }
  }
  return cards;
}

// ──────────────────────────────────────────────
// Room helpers
// ──────────────────────────────────────────────
function nextIdx(room, skip = 1) {
  const len = room.players.length;
  return ((room.turnIndex + skip * room.direction) % len + len) % len;
}

function playerAtOffset(room, offset) {
  return room.players[nextIdx(room, offset)];
}

function sendUpdate(code) {
  const room = rooms[code];
  if (!room) return;
  io.in(code).emit('updatePlayers', {
    players:      room.players.map(p => p.name),
    handCounts:   room.players.map(p => p.hand.length),
    currentPlayer: room.players[room.turnIndex]?.name,
    readyCounts: {
      ready: room.players.filter(p => p.ready).length,
      total: room.players.length,
    },
  });
}

function advanceTurn(code, room, skip = 1) {
  room.turnIndex = nextIdx(room, skip);
  decrementColorLock(code, room);
  room.players.forEach((p, i) => {
    io.to(p.id).emit('yourTurn', i === room.turnIndex);
  });
  sendUpdate(code);
}

function decrementColorLock(code, room) {
  if (!room.colorLock) return;
  room.colorLock.turns--;
  if (room.colorLock.turns <= 0) {
    room.colorLock = null;
    io.in(code).emit('chat-message', { name:'System', message:'🔓 Color Lock expired.' });
  }
}

function checkWin(room, player, code) {
  if (player.hand.length === 0) {
    io.in(code).emit('gameOver', { winner: player.name });
    return true;
  }
  return false;
}

function resolveSpecialAction(code, room, player) {
  if (checkWin(room, player, code)) return;
  advanceTurn(code, room);
}

// ──────────────────────────────────────────────
// Socket logic
// ──────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName  = null;

  // ── Waiting room: join ──────────────────────
  socket.on('join-game', ({ name, code, isHost }) => {
    if (!rooms[code]) {
      if (!isHost) return socket.emit('error-msg', 'Room not found.');
      rooms[code] = {
        host: name, players: [], gameStarted: false,
        topCard: null, turnIndex: 0, direction: 1,
        colorLock: null, pendingAction: null,
      };
    }
    const room = rooms[code];
    if (room.players.find(p => p.name === name)) return socket.emit('name-taken');

    playerName  = name;
    currentRoom = code;
    socket.join(code);
    room.players.push({ name, id: socket.id, hand: [], ready: false, connected: true, calledTMR: false });
    io.in(code).emit('player-list', room.players.map(p => p.name));
    io.in(code).emit('chat-message', { name:'System', message:`${name} joined.` });
  });

  // ── Waiting room: host starts ───────────────
  socket.on('start-game', ({ code, name }) => {
    const room = rooms[code];
    if (!room || room.host !== name || room.players.length < 2) return;

    room.players.forEach(p => { p.hand = drawCards(7); p.ready = false; p.calledTMR = false; });

    // Start card must be a regular colored card
    do { room.topCard = drawCards(1)[0]; }
    while (room.topCard.color === 'Wild' || room.topCard.type === 'Special');

    room.turnIndex  = 0;
    room.direction  = 1;
    room.gameStarted = true;

    room.players.forEach(p => io.to(p.id).emit('deal-hand'));
  });

  // ── Game room: (re)join after redirect ──────
  socket.on('joinGame', ({ name, code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('joinFailed', 'Room not found.');

    const player = room.players.find(p => p.name === name);
    if (!player) return socket.emit('joinFailed', 'You are not in this room.');

    // Cancel pending disconnect timer
    if (disconnectTimers[player.id]) {
      clearTimeout(disconnectTimers[player.id]);
      delete disconnectTimers[player.id];
    }

    player.id        = socket.id;
    player.connected = true;
    playerName       = name;
    currentRoom      = code;
    socket.join(code);

    socket.emit('updateHand',   player.hand);
    socket.emit('updateTopCard', room.topCard);
    socket.emit('yourTurn',      room.players[room.turnIndex]?.name === name);
    sendUpdate(code);

    // Resume pending action for this player
    if (room.pendingAction?.waitingFor === name) {
      socket.emit('chooseTarget', room.pendingAction.data);
    }
  });

  // ── Chat (both rooms) ───────────────────────
  socket.on('chat-message', ({ code, name, message }) => {
    io.in(code || currentRoom).emit('chat-message', { name, message });
  });

  // ── Draw card ───────────────────────────────
  socket.on('drawCard', () => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player || !room.gameStarted) return;
    if (room.players[room.turnIndex]?.name !== playerName) return;

    const [card] = drawCards(1);
    player.hand.push(card);
    socket.emit('updateHand', player.hand);
    sendUpdate(currentRoom); // update counts for everyone

    const top = room.topCard;
    const canPlay = card.color === 'Wild' || card.type === 'Special'
      || card.color === top.color || card.value === top.value;

    if (canPlay) {
      socket.emit('canPlayDrawnCard', card);
    } else {
      advanceTurn(currentRoom, room);
    }
  });

  // ── Pass after draw ─────────────────────────
  socket.on('passAfterDraw', () => {
    const room = rooms[currentRoom];
    if (!room?.gameStarted) return;
    if (room.players[room.turnIndex]?.name !== playerName) return;
    advanceTurn(currentRoom, room);
  });

  // ── Play card ───────────────────────────────
  socket.on('playCard', (card) => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player || !room.gameStarted) return;
    if (room.players[room.turnIndex]?.name !== playerName) return;

    // Color lock check
    if (room.colorLock && card.color !== room.colorLock.color
        && card.color !== 'Wild' && card.type !== 'Special') {
      socket.emit('invalidMove', `🔒 Color Lock! Only ${room.colorLock.color} cards allowed.`);
      return;
    }

    // ── Special cards ──
    if (card.type === 'Special') {
      const idx = player.hand.findIndex(c => c.type === 'Special' && c.special === card.special);
      if (idx === -1) return;
      player.hand.splice(idx, 1);
      room.topCard = { ...card };
      io.in(currentRoom).emit('updateTopCard', room.topCard);
      socket.emit('updateHand', player.hand);

      switch (card.special) {
        case 'bomb': {
          const target = playerAtOffset(room, 1);
          if (target) {
            target.hand = [];
            io.to(target.id).emit('updateHand', target.hand);
            io.in(currentRoom).emit('special-anim', { type:'bomb', target: target.name });
            io.in(currentRoom).emit('chat-message', { name:'System', message:`💣 ${playerName} bombed ${target.name}!` });
          }
          resolveSpecialAction(currentRoom, room, player);
          break;
        }
        case 'swap': {
          const others = room.players.filter(p => p.name !== playerName).map(p => p.name);
          room.pendingAction = { type:'swap', waitingFor: playerName, data: { type:'swap', players: others } };
          socket.emit('chooseTarget', { type:'swap', players: others });
          break;
        }
        case 'peek': {
          const others = room.players.filter(p => p.name !== playerName).map(p => p.name);
          room.pendingAction = { type:'peek', waitingFor: playerName, data: { type:'peek', players: others } };
          socket.emit('chooseTarget', { type:'peek', players: others });
          break;
        }
        case 'steal': {
          const others = room.players.filter(p => p.name !== playerName && p.hand.length > 0).map(p => p.name);
          if (others.length === 0) {
            socket.emit('chat-message', { name:'System', message:'No players to steal from!' });
            resolveSpecialAction(currentRoom, room, player);
          } else {
            room.pendingAction = { type:'steal', waitingFor: playerName, data: { type:'steal', players: others } };
            socket.emit('chooseTarget', { type:'steal', players: others });
          }
          break;
        }
        case 'skipall': {
          io.in(currentRoom).emit('special-anim', { type:'skipall' });
          io.in(currentRoom).emit('chat-message', { name:'System', message:`⏭️ ${playerName} skipped everyone!` });
          decrementColorLock(currentRoom, room);
          sendUpdate(currentRoom);
          socket.emit('yourTurn', true); // same player goes again
          break;
        }
        case 'colorlock': {
          const chosenColor = card.chosenColor || 'Red';
          room.colorLock = { color: chosenColor, turns: 2 };
          io.in(currentRoom).emit('special-anim', { type:'colorlock', color: chosenColor });
          io.in(currentRoom).emit('chat-message', { name:'System', message:`🔒 Color Lock: ${chosenColor} only for 2 turns!` });
          resolveSpecialAction(currentRoom, room, player);
          break;
        }
        case 'reverseattack': {
          room.direction *= -1;
          const target = playerAtOffset(room, 1);
          if (target) {
            target.hand.push(...drawCards(2));
            io.to(target.id).emit('updateHand', target.hand);
            io.in(currentRoom).emit('special-anim', { type:'reverseattack', target: target.name });
            io.in(currentRoom).emit('chat-message', { name:'System', message:`↺ Reversed! ${target.name} draws 2.` });
          }
          resolveSpecialAction(currentRoom, room, player);
          break;
        }
      }
      return;
    }

    // ── Regular card ──
    const top = room.topCard;
    const valid = card.color === 'Wild'
      || card.color === top.color
      || card.value === top.value;

    if (!valid) {
      socket.emit('invalidMove', 'Card must match color or value!');
      return;
    }

    const idx = player.hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (idx === -1) return;
    player.hand.splice(idx, 1);

    // Apply chosen wild color
    let played = { ...card };
    if (card.color === 'Wild' && card.chosenColor) {
      played = { ...card, color: card.chosenColor, wildCard: card.value };
    }
    room.topCard = played;

    io.in(currentRoom).emit('updateTopCard', room.topCard);
    socket.emit('updateHand', player.hand);

    // TMR alert (UNO call)
    if (player.hand.length === 1) {
      player.calledTMR = false;
      io.in(currentRoom).emit('tmr-alert', { name: player.name });
    }

    if (checkWin(room, player, currentRoom)) return;

    // Card effects
    let skip = 1;
    if (card.value === 'Reverse') {
      if (room.players.length === 2) { skip = 2; } // acts as skip
      else { room.direction *= -1; skip = 1; }
    } else if (card.value === 'Skip') {
      skip = 2;
    } else if (card.value === '+2') {
      const t = playerAtOffset(room, 1);
      if (t) { t.hand.push(...drawCards(2)); io.to(t.id).emit('updateHand', t.hand); }
      skip = 2;
    } else if (card.value === '+4') {
      const t = playerAtOffset(room, 1);
      if (t) { t.hand.push(...drawCards(4)); io.to(t.id).emit('updateHand', t.hand); }
      skip = 2;
    }

    advanceTurn(currentRoom, room, skip);
  });

  // ── Special action response (swap/peek/steal) ──
  socket.on('actionResponse', ({ target }) => {
    const room = rooms[currentRoom];
    if (!room?.pendingAction) return;
    const action = room.pendingAction;
    if (action.waitingFor !== playerName) return;
    room.pendingAction = null;

    const player  = room.players.find(p => p.name === playerName);
    const targetP = room.players.find(p => p.name === target);

    switch (action.type) {
      case 'swap': {
        if (targetP) {
          [player.hand, targetP.hand] = [targetP.hand, player.hand];
          io.to(player.id).emit('updateHand', player.hand);
          io.to(targetP.id).emit('updateHand', targetP.hand);
          io.in(currentRoom).emit('special-anim', { type:'swap', target: targetP.name });
          io.in(currentRoom).emit('chat-message', { name:'System', message:`🔄 ${playerName} swapped hands with ${targetP.name}!` });
        }
        break;
      }
      case 'peek': {
        if (targetP) {
          socket.emit('peekResult', { name: targetP.name, hand: targetP.hand });
          io.in(currentRoom).emit('special-anim', { type:'peek', target: targetP.name });
          io.in(currentRoom).emit('chat-message', { name:'System', message:`👀 ${playerName} peeked at ${targetP.name}'s hand!` });
        }
        break;
      }
      case 'steal': {
        if (targetP && targetP.hand.length > 0) {
          const randIdx = Math.floor(Math.random() * targetP.hand.length);
          const stolen  = targetP.hand.splice(randIdx, 1)[0];
          player.hand.push(stolen);
          io.to(player.id).emit('updateHand', player.hand);
          io.to(targetP.id).emit('updateHand', targetP.hand);
          io.in(currentRoom).emit('special-anim', { type:'steal', target: targetP.name });
          io.in(currentRoom).emit('chat-message', { name:'System', message:`🕵️ ${playerName} stole a card from ${targetP.name}!` });
        }
        break;
      }
    }

    resolveSpecialAction(currentRoom, room, player);
  });

  // ── TMR (UNO) call ──────────────────────────
  socket.on('callTMR', () => {
    const room   = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (player && player.hand.length === 1) {
      player.calledTMR = true;
      io.in(currentRoom).emit('chat-message', { name:'System', message:`🃏 ${player.name} called TMR!` });
    }
  });

  socket.on('catchTMR', (offenderName) => {
    const room    = rooms[currentRoom];
    const offender = room?.players.find(p => p.name === offenderName);
    if (offender && offender.hand.length === 1 && !offender.calledTMR) {
      offender.hand.push(...drawCards(2));
      io.to(offender.id).emit('updateHand', offender.hand);
      io.in(currentRoom).emit('chat-message', { name:'System', message:`🚨 ${offenderName} forgot TMR! +2 cards.` });
      offender.calledTMR = true;
      sendUpdate(currentRoom);
    }
  });

  // ── Disconnect ──────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom || !playerName) return;
    const room   = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player) return;
    player.connected = false;

    disconnectTimers[socket.id] = setTimeout(() => {
      if (!rooms[currentRoom]) return;
      const idx = room.players.findIndex(p => p.name === playerName && !p.connected);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.in(currentRoom).emit('chat-message', { name:'System', message:`${playerName} left the game.` });
        sendUpdate(currentRoom);
        if (room.players.length === 0) delete rooms[currentRoom];
      }
      delete disconnectTimers[socket.id];
    }, 45_000);
  });
});

server.listen(PORT, () => console.log(`✅  tmrflip running → http://localhost:${PORT}`));
