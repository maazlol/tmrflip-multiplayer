const colors = ["Red", "Green", "Blue", "Yellow"];
const values = ["0", "1", ..., "Reverse", "+2", "Skip", "Wild", "Wild+4"];

function generateDeck() {
  let deck = [];
  for (let color of colors) {
    for (let value of values) {
      if (value.startsWith("Wild")) {
        deck.push({ color: "Wild", value });
      } else {
        deck.push({ color, value });
      }
    }
  }
  return deck;
}
module.exports = { generateDeck };
