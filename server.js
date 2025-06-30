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

app.get('/getName', (req, res) => {
  const name = 'Player' + Math.floor(Math.random() * 10000);
  res.json({ name });
});

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

  // NO CHANGE: waiting.html, index.html logic remains as is

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
    room.players.push({ name, id: socket.id, hand: [], ready: false });

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
      p.hand = drawCards(5);
      p.ready = false;
    });
    room.topCard = drawCards(1)[0];
    room.turnIndex = 0;
    room.direction = 1;
    room.gameStarted = true;

    room.players.forEach(p => {
      io.to(p.id).emit('deal-hand');
    });
  });

  // --- main change: joinGame will assign pregame hand if not assigned
  socket.on('joinGame', (name) => {
    const code = socket.handshake.headers.referer.split('?code=')[1]?.split('&')[0];
    const room = rooms[code];
    if (!room) return;

    if (room.players.find(p => p.name === name && p.id !== socket.id)) {
      socket.emit('joinFailed', 'Name already taken.');
      return;
    }

    const player = room.players.find(p => p.name === name);
    if (player) player.id = socket.id;
    playerName = name;
    currentRoom = code;

    // Pregame: Give hand if not already assigned
    if (player && (!player.hand || player.hand.length === 0)) {
      player.hand = drawCards(5);
    }
    // Always send hand on join, so game.html can show cards
    socket.emit('updateHand', player.hand);

    sendUpdate(code);
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

  socket.on('drawCard', () => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (player) {
      const card = drawCards(1)[0];
      player.hand.push(card);
      socket.emit('updateHand', player.hand);
    }
  });

  socket.on('playCard', (card) => {
    const room = rooms[currentRoom];
    const player = room?.players.find(p => p.name === playerName);
    if (!player) return;

    const index = player.hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (index === -1) return;

    player.hand.splice(index, 1);
    room.topCard = card;

    // Wild Card color selection simulation
    if (card.color === 'Wild') {
      // Set to a random color
      const randomColor = ['Red', 'Green', 'Blue', 'Yellow'][Math.floor(Math.random() * 4)];
      card.color = randomColor;
    }

    if (card.value === 'Reverse') {
      room.direction *= -1;
    } else if (card.value === 'Skip') {
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

    io.in(currentRoom).emit('updateTopCard', card);
    socket.emit('updateHand', player.hand);

    if (player.hand.length === 0) {
      io.in(currentRoom).emit('gameOver', { winner: player.name });
      return;
    }

    room.players.forEach((p, i) => {
      io.to(p.id).emit('yourTurn', i === room.turnIndex);
    });

    sendUpdate(currentRoom);
  });

  socket.on('disconnect', () => {
    const room = rooms[currentRoom];
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      sendUpdate(currentRoom);
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

  // --- main change: sendUpdate now includes readyCounts for game.html
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
