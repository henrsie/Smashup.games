// backend/bases.js

const basesData = [
  {
    id: 'base_the_plant',
    name: 'The Central Brain',
    breakpoint: 20,
    vp: [4, 2, 1], // 1st place, 2nd place, 3rd place victory points
    ability: 'Ongoing: After a minion is played here, draw a card.'
  },
  {
    id: 'base_temple_of_lie',
    name: 'Temple of Lies',
    breakpoint: 18,
    vp: [3, 2, 1],
    ability: 'Ongoing: Minions here have -1 power.'
  },
  {
    id: 'base_tortuga',
    name: 'Tortuga',
    breakpoint: 23,
    vp: [4, 3, 2],
    ability: 'Ongoing: After a base breaks, winner here may move a minion to another base.'
  },
  {
    id: 'base_the_homeworld',
    name: 'The Homeworld',
    breakpoint: 25,
    vp: [4, 2, 1],
    ability: 'Ongoing: When you play a minion here, you may play an extra minion of power 2 or less.'
  },
  {
    id: 'base_jungle',
    name: 'The Great Tree',
    breakpoint: 16,
    vp: [3, 2, 1],
    ability: 'Ongoing: Minions here cannot be moved.'
  },
  {
    id: 'base_tar_pits',
    name: 'Tar Pits',
    breakpoint: 20,
    vp: [3, 2, 1],
    ability: 'Ongoing: Destroy any minion of power 2 or less played here.'
  }
];

function buildBaseDeck() {
  // Shuffle base deck template instances
  let deck = [...basesData];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

module.exports = { basesData, buildBaseDeck };