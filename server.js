const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let games = {};

io.on('connection', (socket) => {
  socket.on('join-game', ({ name, code, isHost }) => {
    if (!games[code]) {
      if (isHost) {
        games[code] = {
          players: [],
          started: false,
          hands: {},
          topCard: null,
          turnIndex: 0,
          direction: 1,
        };
      } else {
        socket.emit('error-message', 'This game does not exist.');
        return;
      }
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

  socket.on('joinGameRoom', ({ name, room }) => {
    const game = games[room];
    if (!game || !game.started) return;

    socket.join(room);
    socket.code = room;
    socket.name = name;

    io.to(room).emit('gameState', {
      players: game.players.map(n => ({
        name: n,
        hand: game.hands[n]
      })),
      topCard: game.topCard,
      currentTurn: game.players[game.turnIndex]
    });
  });

  socket.on('start-game', ({ code, name }) => {
    const game = games[code];
    if (!game || game.started) return;

    if (game.players[0] !== name) {
      socket.emit('error-message', 'Only host can start the game.');
      return;
    }

    startGame(code);
  });

  socket.on('playCard', ({ room, card, index }) => {
    const game = games[room];
    const name = socket.name;
    if (!game || !game.started) return;
    if (game.players[game.turnIndex] !== name) return;

    const playerHand = game.hands[name];
    const handCard = playerHand[index];
    if (!handCard || handCard.color !== card.color || handCard.value !== card.value) return;

    playerHand.splice(index, 1);
    game.topCard = card;

    let skipNext = false;
    if (card.value === 'Skip') skipNext = true;
    if (card.value === 'Reverse') game.direction *= -1;
    if (card.value === '+2') {
      const nextIndex = (game.turnIndex + game.direction + game.players.length) % game.players.length;
      const nextPlayer = game.players[nextIndex];
      game.hands[nextPlayer].push(...drawCards(2));
    }

    if (playerHand.length === 0) {
      io.to(room).emit('gameOver', name);
      delete games[room];
      return;
    }

    game.turnIndex = (game.turnIndex + (skipNext ? 2 : 1) * game.direction + game.players.length) % game.players.length;

    io.to(room).emit('gameState', {
      players: game.players.map(n => ({
        name: n,
        hand: game.hands[n]
      })),
      topCard: game.topCard,
      currentTurn: game.players[game.turnIndex]
    });
  });

  socket.on('drawCard', ({ room }) => {
    const game = games[room];
    const name = socket.name;
    if (!game || !game.started) return;
    if (game.players[game.turnIndex] !== name) return;

    const newCard = drawCards(1)[0];
    game.hands[name].push(newCard);

    game.turnIndex = (game.turnIndex + game.direction + game.players.length) % game.players.length;

    io.to(room).emit('gameState', {
      players: game.players.map(n => ({
        name: n,
        hand: game.hands[n]
      })),
      topCard: game.topCard,
      currentTurn: game.players[game.turnIndex]
    });
  });

  socket.on('chat-message', ({ name, message }) => {
    const code = socket.code;
    io.to(code).emit('chat-message', { name, message });
  });

  socket.on('disconnect', () => {
    const code = socket.code;
    const name = socket.name;

    if (games[code]) {
      games[code].players = games[code].players.filter((n) => n !== name);
      delete games[code].hands?.[name];
      io.to(code).emit('player-list', games[code].players);

      if (games[code].players.length === 0) {
        delete games[code];
      }
    }
  });
});

function drawCards(count) {
  const colors = ['🔴', '🟡', '🟢', '🔵'];
  const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
  const cards = [];
  for (let i = 0; i < count; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const value = values[Math.floor(Math.random() * values.length)];
    cards.push({ color, value });
  }
  return cards;
}

function startGame(code) {
  const game = games[code];
  if (!game) return;

  game.started = true;
  const hands = {};
  for (const player of game.players) {
    hands[player] = drawCards(5);
  }

  const topCard = drawCards(1)[0];
  game.hands = hands;
  game.topCard = topCard;
  game.turnIndex = 0;
  game.direction = 1;

  io.to(code).emit('gameState', {
    players: game.players.map(n => ({
      name: n,
      hand: hands[n]
    })),
    topCard,
    currentTurn: game.players[game.turnIndex]
  });
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
