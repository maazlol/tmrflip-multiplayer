const Card = require("./card");

function generateDeck() {
  const colors = ["Red", "Green", "Blue", "Yellow"];
  const values = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "Skip", "Reverse", "+2"
  ];
  const deck = [];

  for (let color of colors) {
    for (let value of values) {
      deck.push(new Card(color, value));
      if (value !== "0") deck.push(new Card(color, value)); // two of each except 0
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push(new Card("Wild", "Wild"));
    deck.push(new Card("Wild", "+4"));
  }

  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

module.exports = { generateDeck };
