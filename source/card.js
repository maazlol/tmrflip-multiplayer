class Card {
  constructor(color, value) {
    this.color = color;
    this.value = value;
  }

  isPlayableOn(topCard) {
    return this.color === topCard.color || this.value === topCard.value || this.color === 'Wild';
  }
}
module.exports = Card;
