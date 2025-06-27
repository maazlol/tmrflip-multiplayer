const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const gameRooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-game', ({ name, code }) => {
    socket.join(code);

    if (!gameRooms[code]) {
      gameRooms[code] = [];
    }

    gameRooms[code].push({ id: socket.id, name });
    const names = gameRooms[code].map(p => p.name);
    io.to(code).emit('player-list', names);
  });

  socket.on('chat-message', ({ code, name, message }) => {
    io.to(code).emit('chat-message', { name, message });
  });

  socket.on('disconnect', () => {
    for (const code in gameRooms) {
      const room = gameRooms[code];
      const index = room.findIndex(p => p.id === socket.id);

      if (index !== -1) {
        room.splice(index, 1);
        if (room.length === 0) {
          delete gameRooms[code];
        } else {
          const names = room.map(p => p.name);
          io.to(code).emit('player-list', names);
        }
        break;
      }
    }

    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
