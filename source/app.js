// source/app.js
const Game = require("./game");

const games = {}; // roomCode => Game instance

module.exports = (io) => {
  io.on("connection", (socket) => {
    let playerName = "";
    let roomCode = socket.handshake.query.code;

    socket.on("joinGame", (name) => {
      if (!roomCode || !name) {
        socket.emit("joinFailed", "Missing name or room code");
        return;
      }

      playerName = name;

      if (!games[roomCode]) {
        games[roomCode] = new Game(roomCode);
      }

      const game = games[roomCode];
      const success = game.addPlayer(name, socket.id);

      if (!success) {
        socket.emit("joinFailed", "Name already taken");
        return;
      }

      socket.join(roomCode);

      io.to(roomCode).emit("updatePlayers", {
        players: game.getPlayerNames(),
        handCounts: game.getHandCounts(),
        currentPlayer: game.getCurrentPlayerName(),
      });
    });

    socket.on("playerReady", () => {
      const game = games[roomCode];
      if (!game) return;

      game.markReady(playerName);

      if (game.isReadyToStart()) {
        game.start();

        io.to(roomCode).emit("startGame");
        io.to(roomCode).emit("updateTopCard", game.topCard);

        for (let name of game.getPlayerNames()) {
          io.to(game.getSocketId(name)).emit("updateHand", game.getHand(name));
        }

        const current = game.getCurrentPlayerName();
        io.to(game.getSocketId(current)).emit("yourTurn", true);
      }
    });

    socket.on("drawCard", () => {
      const game = games[roomCode];
      game.drawCard(playerName);
      socket.emit("updateHand", game.getHand(playerName));
    });

    socket.on("playCard", (card) => {
      const game = games[roomCode];
      const result = game.playCard(playerName, card);

      if (result.error) {
        socket.emit("invalidMove", result.error);
        return;
      }

      io.to(roomCode).emit("updateTopCard", game.topCard);

      for (let name of game.getPlayerNames()) {
        io.to(game.getSocketId(name)).emit("updateHand", game.getHand(name));
      }

      if (result.winner) {
        io.to(roomCode).emit("gameOver", { winner: result.winner });
      } else {
        const current = game.getCurrentPlayerName();
        io.to(roomCode).emit("updatePlayers", {
          players: game.getPlayerNames(),
          handCounts: game.getHandCounts(),
          currentPlayer: current,
        });
        io.to(game.getSocketId(current)).emit("yourTurn", true);
      }
    });

    socket.on("disconnect", () => {
      const game = games[roomCode];
      if (game) {
        game.removePlayer(playerName);
        io.to(roomCode).emit("updatePlayers", {
          players: game.getPlayerNames(),
          handCounts: game.getHandCounts(),
          currentPlayer: game.getCurrentPlayerName(),
        });
      }
    });
  });
};
