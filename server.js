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
      games[code] = [];
    }

    if (games[code].includes(name)) {
      socket.emit('name-taken');
      return;
    }

    games[code].push(name);
    socket.join(code);
    socket.code = code;
    socket.name = name;

    io.to(code).emit('player-list', games[code]);

    socket.on('chat-message', ({ name, message }) => {
      io.to(code).emit('chat-message', { name, message });
    });

    socket.on('start-game', ({ code }) => {
      io.to(code).emit('start-game');
    });

    socket.on('disconnect', () => {
      const code = socket.code;
      const name = socket.name;

      if (games[code]) {
        games[code] = games[code].filter(n => n !== name);
        io.to(code).emit('player-list', games[code]);

        if (games[code].length === 0) {
          delete games[code];
        }
      }
    });
  });
});

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
