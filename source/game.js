const { generateDeck } = require("./deck");

class Game {
  constructor() {
    this.players = [];
    this.playerSockets = {}; // name -> socket.id
    this.hands = {}; // name -> array of cards
    this.turn = 0;
    this.direction = 1;
    this.topCard = null;
    this.deck = generateDeck();
    this.started = false;
  }

  addPlayer(name, socketId) {
    if (this.players.includes(name)) return false;
    this.players.push(name);
    this.playerSockets[name] = socketId;
    this.hands[name] = [];
    return true;
  }

  markReady(name) {
    // Add logic later if needed
    if (this.allReady()) this.startGame();
  }

  allReady() {
    return this.players.length > 1;
  }

  startGame() {
    for (let name of this.players) {
      for (let i = 0; i < 7; i++) {
        this.hands[name].push(this.deck.pop());
      }
    }
    this.topCard = this.deck.pop();
    this.started = true;
  }

  getCurrentPlayer() {
    return this.players[this.turn];
  }

  nextTurn() {
    this.turn = (this.turn + this.direction + this.players.length) % this.players.length;
  }

  playCard(name, card) {
    if (this.getCurrentPlayer() !== name) return { error: "Not your turn" };

    const index = this.hands[name].findIndex(
      (c) => c.color === card.color && c.value === card.value
    );
    if (index === -1) return { error: "Card not in hand" };

    if (
      card.color !== this.topCard.color &&
      card.value !== this.topCard.value &&
      card.color !== "Wild"
    ) {
      return { error: "Invalid move" };
    }

    this.hands[name].splice(index, 1);
    this.topCard = card;

    // Apply effects
    if (card.value === "Reverse") this.direction *= -1;
    else if (card.value === "Skip") this.nextTurn();
    else if (card.value === "+2") {
      const next = this.players[(this.turn + this.direction + this.players.length) % this.players.length];
      this.hands[next].push(this.deck.pop(), this.deck.pop());
    } else if (card.value === "+4") {
      const next = this.players[(this.turn + this.direction + this.players.length) % this.players.length];
      for (let i = 0; i < 4; i++) this.hands[next].push(this.deck.pop());
    }

    // Check winner
    if (this.hands[name].length === 0) {
      return { winner: name };
    }

    this.nextTurn();
    return { success: true };
  }

  drawCard(name) {
    const card = this.deck.pop();
    this.hands[name].push(card);
    return card;
  }

  getHand(name) {
    return this.hands[name];
  }

  getHandCounts() {
    return this.players.map((name) => this.hands[name].length);
  }
}

module.exports = Game;

