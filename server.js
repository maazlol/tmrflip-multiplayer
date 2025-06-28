const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let games = {};

function drawCards(count) {
  const pool = ['🔴 1', '🟡 2', '🔵 Skip', '🟢 +2', '🔴 9', '🟡 5', '🟢 Reverse', '🔵 +4'];
  const cards = [];
  for (let i = 0; i < count; i++) {
    cards.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return cards;
}

io.on('connection', (socket) => {
  socket.on('join-game', ({ name, code }) => {
    if (!games[code]) {
      games[code] = {
        players: [],
        hands: {},
        started: false,
        currentTurn: 0,
        deck: [],
        discard: []
      };
    }

    const game = games[code];

    if (game.players.includes(name)) {
      socket.emit('name-taken');
      return;
    }

    game.players.push(name);
    socket.join(code);
    socket.code = code;
    socket.name = name;

    io.to(code).emit('player-list', game.players);
  });

  socket.on('start-game', ({ code }) => {
    const game = games[code];
    if (!game || game.started) return;

    game.started = true;
    game.deck = shuffleDeck();

    for (const player of game.players) {
      game.hands[player] = drawCards(3);
    }

    game.discard.push(game.deck.pop());

    io.to(code).emit('deal-hand', {
      hands: game.hands,
      topCard: game.discard[game.discard.length - 1],
      turn: game.players[game.currentTurn]
    });
  });

  socket.on('play-card', ({ code, name, card }) => {
    const game = games[code];
    if (!game || game.players[game.currentTurn] !== name) return;

    const hand = game.hands[name];
    const index = hand.indexOf(card);
    if (index > -1) {
      hand.splice(index, 1);
      game.discard.push(card);

      game.currentTurn = (game.currentTurn + 1) % game.players.length;

      io.to(code).emit('update-game', {
        hands: game.hands,
        topCard: game.discard[game.discard.length - 1],
        turn: game.players[game.currentTurn]
      });
    }
  });

  socket.on('draw-card', ({ code, name }) => {
    const game = games[code];
    if (!game || game.players[game.currentTurn] !== name) return;
    if (game.deck.length === 0) return;

    game.hands[name].push(game.deck.pop());

    io.to(code).emit('update-game', {
      hands: game.hands,
      topCard: game.discard[game.discard.length - 1],
      turn: game.players[game.currentTurn]
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
      const game = games[code];
      game.players = game.players.filter(n => n !== name);
      delete game.hands[name];

      io.to(code).emit('player-list', game.players);

      if (game.players.length === 0) {
        delete games[code];
      }
    }
  });
});

function shuffleDeck() {
  const pool = [
    '🔴 1', '🔴 2', '🔴 3', '🔴 4', '🔴 5', '🔴 6', '🔴 7', '🔴 8', '🔴 9', '🔴 +2', '🔴 Skip', '🔴 Reverse',
    '🟡 1', '🟡 2', '🟡 3', '🟡 4', '🟡 5', '🟡 6', '🟡 7', '🟡 8', '🟡 9', '🟡 +2', '🟡 Skip', '🟡 Reverse',
    '🔵 1', '🔵 2', '🔵 3', '🔵 4', '🔵 5', '🔵 6', '🔵 7', '🔵 8', '🔵 9', '🔵 +2', '🔵 Skip', '🔵 Reverse',
    '🟢 1', '🟢 2', '🟢 3', '🟢 4', '🟢 5', '🟢 6', '🟢 7', '🟢 8', '🟢 9', '🟢 +2', '🟢 Skip', '🟢 Reverse',
    '🃏 Wild', '🃏 +4', '🃏 Wild', '🃏 +4'
  ];
  return pool.sort(() => Math.random() - 0.5);
}

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
