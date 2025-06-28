const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

let games = {};

io.on('connection', (socket) => {
  socket.on('join-game', ({ name, code }) => {
    if (!games[code]) {
      games[code] = { players: [], hands: {}, started: false };
    }

    const game = games[code];

    if (game.players.find(p => p.name === name)) {
      socket.emit('name-taken');
      return;
    }

    const player = { id: socket.id, name };
    game.players.push(player);
    socket.code = code;
    socket.name = name;
    socket.join(code);

    io.to(code).emit('player-list', game.players.map(p => p.name));
  });

  socket.on('start-game', ({ code }) => {
    const game = games[code];
    if (!game || game.started) return;

    game.started = true;

    for (const player of game.players) {
      const hand = drawCards(6);
      game.hands[player.name] = hand;
      io.to(player.id).emit('deal-hand', hand);
    }

    const counts = {};
    for (const player of game.players) {
      counts[player.name] = game.hands[player.name].length;
    }

    io.to(code).emit('player-counts', counts);
  });

  socket.on('chat-message', ({ name, message }) => {
    const code = socket.code;
    if (code) {
      io.to(code).emit('chat-message', { name, message });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.code;
    const name = socket.name;
    const game = games[code];

    if (game) {
      game.players = game.players.filter(p => p.name !== name);
      delete game.hands?.[name];

      io.to(code).emit('player-list', game.players.map(p => p.name));

      if (game.players.length === 0) delete games[code];
    }
  });
});

function drawCards(count) {
  const pool = ['🔴 1', '🟡 2', '🔵 Skip', '🟢 +2', '🔴 9', '🟡 5', '🟢 Reverse', '🔵 +4'];
  const cards = [];
  for (let i = 0; i < count; i++) {
    cards.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return cards;
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
