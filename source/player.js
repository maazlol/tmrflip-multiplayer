class Player {
  constructor(name, socketId) {
    this.name = name;
    this.socketId = socketId;
    this.hand = [];
    this.isReady = false;
  }
}
module.exports = Player;

