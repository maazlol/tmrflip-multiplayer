const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let globalPlayers = [];
let gameStarted = false;
let gameTopCard = null;
let gameTurnIndex = 0;

app.get('/getName', (req, res) => {
  const name = 'Player' + Math.floor(Math.random() * 10000);
  res.json({ name });
});

function drawCards(n = 1) {
  const colors = ['Red', 'Green', 'Blue', 'Yellow'];
  const values = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
  const cards = [];
  for (let i = 0; i < n; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const value = values[Math.floor(Math.random() * values.length)];
    cards.push({ color, value });
  }
  return cards;
}

function sendUpdate(currentTurn = null) {
  const players = globalPlayers.map(p => p.name);
  const handCounts = globalPlayers.map(p => p.hand.length);
  const currentPlayer = currentTurn !== null ? globalPlayers[currentTurn]?.name : null;
  io.emit('updatePlayers', { players, handCounts, currentPlayer });
}

io.on('connection', socket => {
  socket.on('joinGame', (name) => {
    if (globalPlayers.find(p => p.name === name)) {
      socket.emit('joinFailed', 'Name already taken.');
      return;
    }
    const newPlayer = {
      name,
      id: socket.id,
      hand: drawCards(5),
      ready: false
    };
    globalPlayers.push(newPlayer);
    socket.name = name;
    sendUpdate();
  });

  socket.on('playerReady', () => {
    const player = globalPlayers.find(p => p.name === socket.name);
    if (player) player.ready = true;
    sendUpdate();

    if (globalPlayers.length > 1 && globalPlayers.every(p => p.ready) && !gameStarted) {
      gameStarted = true;
      gameTopCard = drawCards(1)[0];
      gameTurnIndex = 0;
      io.emit('startGame');
      io.emit('updateTopCard', gameTopCard);

      globalPlayers.forEach((p, i) => {
        io.to(p.id).emit('updateHand', p.hand);
        io.to(p.id).emit('yourTurn', i === gameTurnIndex);
      });

      sendUpdate(gameTurnIndex);
    }
  });

  socket.on('drawCard', () => {
    const player = globalPlayers.find(p => p.name === socket.name);
    if (player) {
      const newCard = drawCards(1)[0];
      player.hand.push(newCard);
      socket.emit('updateHand', player.hand);
    }
  });

  socket.on('playCard', (card) => {
    const player = globalPlayers.find(p => p.name === socket.name);
    if (!player) return;

    const index = player.hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (index !== -1) {
      player.hand.splice(index, 1);
      io.emit('updateTopCard', card);
      socket.emit('updateHand', player.hand);

      if (player.hand.length === 0) {
        io.emit('gameOver', { winner: player.name });
      }
    }
  });

  socket.on('disconnect', () => {
    globalPlayers = globalPlayers.filter(p => p.id !== socket.id);
    sendUpdate();
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
