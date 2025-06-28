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
      games[code] = { players: [], started: false };
    }

    if (games[code].players.includes(name)) {
      socket.emit('name-taken');
      return;
    }

    games[code].players.push(name);
    socket.join(code);
    socket.code = code;
    socket.name = name;

    io.to(code).emit('player-list', games[code].players);
  });

  socket.on('start-game', ({ code }) => {
    const game = games[code];
    if (!game || game.started) return;

    game.started = true;

    const hands = {};
    for (const player of game.players) {
      hands[player] = drawCards(3); // basic 3 cards per player
    }

    io.to(code).emit('deal-hand', hands);
  });

  socket.on('chat-message', ({ name, message }) => {
    const code = socket.code;
    io.to(code).emit('chat-message', { name, message });
  });

  socket.on('disconnect', () => {
    const code = socket.code;
    const name = socket.name;

    if (games[code]) {
      games[code].players = games[code].players.filter(n => n !== name);
      io.to(code).emit('player-list', games[code].players);
      if (games[code].players.length === 0) delete games[code];
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
