class Player {
  constructor(name, socketId) {
    this.name = name;
    this.socketId = socketId;
    this.hand = [];
    this.isReady = false;
  }

  drawCard(card) {
    this.hand.push(card);
  }

  removeCard(cardToRemove) {
    const index = this.hand.findIndex(
      (card) =>
        card.color === cardToRemove.color && card.value === cardToRemove.value
    );
    if (index !== -1) {
      this.hand.splice(index, 1);
      return true;
    }
    return false;
  }
}

module.exports = Player;


