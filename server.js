const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const gameRooms = {};

io.on('connection', (socket) => {
  socket.on('join-game', ({ name, code }) => {
    socket.join(code);

    if (!gameRooms[code]) {
      gameRooms[code] = [];
    }

    gameRooms[code].push({ id: socket.id, name });
  });

  socket.on('chat-message', ({ code, name, message }) => {
    io.to(code).emit('chat-message', { name, message });
  });

  socket.on('disconnect', () => {
    for (const code in gameRooms) {
      gameRooms[code] = gameRooms[code].filter(p => p.id !== socket.id);
      if (gameRooms[code].length === 0) {
        delete gameRooms[code];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
