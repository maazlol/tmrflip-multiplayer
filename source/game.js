class Game {
  constructor() {
    this.players = [];
    this.hands = {};
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.topCard = null;
    this.deck = this.createDeck();
    this.started = false;
  }

  createDeck() { /* full UNO deck */ }
  shuffleDeck() { /* shuffle logic */ }
  dealCards() { /* give 7 cards per player */ }
  playCard(playerName, card) { /* validate + apply effect */ }
  drawCard(playerName) { /* give one card */ }
  nextTurn() { /* increment or reverse turn */ }
}
module.exports = Game;
