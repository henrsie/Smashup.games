// backend/factions.js

const { systemRandom } = require('./random.js');
const { getCardEntityId, getFactionEntityId } = require('./gameEntityIds.js');

const factionsData = {
  Dinosaurs: {
    name: "Dinosaurs",
    cards: [
      // Minions (Total: 10)
      { id: 'dino_war_raptor_1', name: 'War Raptor', type: 'minion', power: 2, count: 4, ability: 'Ongoing: Gains +1 power for each War Raptor on this base (including this one).', subtype: 'base', discard: 'no' },
      { id: 'dino_bro_1', name: 'Laseratops', type: 'minion', power: 4, count: 2, ability: 'You may destroy a minion here of power 2 or less.', subtype: 'base', discard: 'no' },
      { id: 'dino_king_1', name: 'King Rex', type: 'minion', power: 7, count: 1, ability: '', subtype: 'base', discard: 'no' },
      { id: 'dino_armor_1', name: 'Armor Stego', type: 'minion', power: 3, count: 3, ability: 'Ongoing: This minion gains +2 power on other player\'s turns until the start of your next turn. ', subtype: 'base', discard: 'no' },

      // actions (Total: 10)
      { id: 'dino_howl_1', name: 'Howl', type: 'action', count: 2, ability: 'Each of your minions gains +1 power until the end of your turn.', subtype: 'neither', discard: 'yes' },
      { id: 'dino_augmentation_1', name: 'Augmentation', type: 'action', count: 2, ability: 'One minion gains +4 power until the end of your turn.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'dino_tooth_1', name: 'Tooth and Claw... and Guns', type: 'action', count: 1, ability: "Play on a minion. Ongoing: This minion is not affected by other players' cards.", subtype: 'ally-minion', discard: 'no' },
      { id: 'dino_upgrade_1', name: 'Upgrade', type: 'action', count: 1, ability: 'Play on a minion. Ongoing: This minion has +2 power.', subtype: 'ally-minion', discard: 'no' },
      { id: 'dino_wildlife_preserve_1', name: 'Wildlife Preserve', type: 'action', count: 1, ability: 'Play on a base. Ongoing: Your minions here are not affected by other players’ actions.', subtype: 'base', discard: 'no' },
      { id: 'dino_natural_selection_1', name: 'Natural Selection', type: 'action', count: 1, ability: 'Choose one of your minions on a base. Destroy a minion there with less power than yours.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'dino_rampage_1', name: 'Rampage', type: 'action', count: 1, ability: 'Reduce the breakpoint of a base by the power of one of your minions on that base until the end of the turn.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'dino_survival_1', name: 'Survival of the Fittest', type: 'action', count: 1, ability: 'Destroy the lowest-power minion (you choose in case of a tie) on each base with a higher-power minion.', subtype: 'neither', discard: 'yes' }
    ]
  },
  Aliens: {
    name: "Aliens",
    cards: [
      // Minions (Total: 10)
      { id: 'alien_supreme_overlord_1', name: 'Supreme Overlord', type: 'minion', power: 5, count: 1, ability: 'You may return a minion to its owner\'s hand.', subtype: 'base', discard: 'no' },
      { id: 'alien_invader_1', name: 'Invader', type: 'minion', power: 3, count: 2, ability: 'You may gain 1 VP.', subtype: 'base', discard: 'no' },
      { id: 'alien_scout_1', name: 'Scout', type: 'minion', power: 3, count: 3, ability: 'Special: After this base scores, you may return this minion to your hand.', subtype: 'base', discard: 'no' },
      { id: 'alien_collector_1', name: 'Collector', type: 'minion', power: 2, count: 4, ability: 'You may return a minion of power 3 or less on this base to its owner\'s hand.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'alien_abduction_1', name: 'Abduction', type: 'action', count: 1, ability: 'Return a minion to its owner\'s hand. Play an extra minion.', subtype: 'neutral-minion', discard: 'yes' },
      { id: 'alien_beam_up_1', name: 'Beam Up', type: 'action', count: 2, ability: 'Return a minion to its owner\'s hand.', subtype: 'neutral-minion', discard: 'yes' },
      { id: 'alien_crop_circles_1', name: 'Crop Circles', type: 'action', count: 1, ability: 'Choose a base. Return each minion on that base to its owner\'s hand.', subtype: 'base', discard: 'yes' },
      { id: 'alien_disintegrator_1', name: 'Disintegrator', type: 'action', count: 2, ability: 'Place a minion of power 3 or less on the bottom of its owner\'s deck.', subtype: 'neutral-minion', discard: 'yes' },
      { id: 'alien_invasion_1', name: 'Invasion', type: 'action', count: 1, ability: 'Move a minion to another base.', subtype: 'neutral-minion', discard: 'yes' },
      { id: 'alien_jammed_signal_1', name: 'Jammed Signal', type: 'action', count: 1, ability: 'Play on a base. Ongoing: This base\'s abilities are cancelled.', subtype: 'base', discard: 'no' },
      { id: 'alien_probe_1', name: 'Probe', type: 'action', count: 1, ability: 'Look at another player\'s hand and choose a minion in it. That player discards that minion.', subtype: 'player', discard: 'yes' },
      { id: 'alien_terraforming_1', name: 'Terraforming', type: 'action', count: 1, ability: 'Search the base deck for a base and swap it with a base in play. You may play an extra minion there.', subtype: 'base', discard: 'yes' }
    ]
  },
  Ninjas: {
    name: "Ninjas",
    cards: [
      // Minions (Total: 10)
      { id: 'ninja_master_1', name: 'Ninja Master', type: 'minion', power: 5, count: 1, ability: 'You may destroy a minion on this base.', subtype: 'base', discard: 'no' },
      { id: 'ninja_tiger_assassin_1', name: 'Tiger Assassin', type: 'minion', power: 4, count: 2, ability: 'You may destroy a minion of power 3 or less on this base.', subtype: 'base', discard: 'no' },
      { id: 'ninja_shinobi_1', name: 'Shinobi', type: 'minion', power: 3, count: 3, ability: 'Special: Before a base scores, you may play this minion there. You can only use one Shinobi’s ability per base.', subtype: 'base', discard: 'no' },
      { id: 'ninja_acolyte_1', name: 'Ninja Acolyte', type: 'minion', power: 2, count: 4, ability: 'Talent: If you have not played a minion on this turn, you may return this minion to your hand and play an extra minion here immediately.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'ninja_assassination_1', name: 'Assassination', type: 'action', count: 1, ability: 'Play on a minion. Ongoing: Destroy this minion at the end of the turn.', subtype: 'enemy-minion', discard: 'no' },
      { id: 'ninja_disguise_1', name: 'Disguise', type: 'action', count: 1, ability: 'Choose one or two of your minions on one base. Play an equal number of extra minions there, and return the chosen minions to your hand.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'ninja_hidden_ninja_1', name: 'Hidden Ninja', type: 'action', count: 1, ability: 'Special: Before a base scores, play a minion there.', subtype: 'neither', discard: 'yes' },
      { id: 'ninja_infiltrate_1', name: 'Infiltrate', type: 'action', count: 2, ability: 'Play on a base. Ongoing: You may ignore this base’s ability. Destroy this card at the start of your turn.', subtype: 'base', discard: 'no' },
      { id: 'ninja_poison_1', name: 'Poison', type: 'action', count: 1, ability: 'Play on a minion. Destroy any number of actions on it. Ongoing: This minion has -4 power. (Minions have minimum power of 0.)', subtype: 'enemy-minion', discard: 'no' },
      { id: 'ninja_seeing_stars_1', name: 'Seeing Stars', type: 'action', count: 2, ability: 'Destroy a minion of power 3 or less.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'ninja_smoke_bomb_1', name: 'Smoke Bomb', type: 'action', count: 1, ability: 'Play on one of your minions. Ongoing: This minion is not affected by other players\' actions.', subtype: 'ally-minion', discard: 'no' },
      { id: 'ninja_way_of_deception_1', name: 'Way of Deception', type: 'action', count: 1, ability: 'Move one of your minions to another base.', subtype: 'ally-minion', discard: 'yes' }
    ]
  },
  Pirates: {
    name: "Pirates",
    cards: [
      // Minions (Total: 10)
      { id: 'pirate_king_1', name: 'Pirate King', type: 'minion', power: 5, count: 1, ability: 'Special: Before a base scores, you may move this minion there.', subtype: 'base', discard: 'no' },
      { id: 'pirate_buccaneer_1', name: 'Buccaneer', type: 'minion', power: 4, count: 2, ability: 'Ongoing: Once per turn, if this minion would be destroyed, you may move it to another base instead.', subtype: 'base', discard: 'no' },
      { id: 'pirate_cut_lass_1', name: 'Cut Lass', type: 'minion', power: 3, count: 3, ability: 'You may destroy a minion here of power 2 or less.', subtype: 'base', discard: 'no' },
      { id: 'pirate_first_mate_1', name: 'First Mate', type: 'minion', power: 2, count: 4, ability: 'Special: After this base is scored, you may move this minion to another base instead of the discard pile.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'pirate_broadside_1', name: 'Broadside', type: 'action', count: 2, ability: 'Destroy all of one player\'s minions of power 2 or less on a base where you have a minion.', subtype: 'player', discard: 'yes' },
      { id: 'pirate_cannon_1', name: 'Cannon', type: 'action', count: 1, ability: 'Destroy up to two minions of power 2 or less.', subtype: 'neither', discard: 'yes' },
      { id: 'pirate_dinghy_1', name: 'Dinghy', type: 'action', count: 2, ability: 'Move up to two of your minions to other bases.', subtype: 'neither', discard: 'yes' },
      { id: 'pirate_full_sail_1', name: 'Full Sail', type: 'action', count: 1, ability: 'Move any number of your minions to other bases. Special: Before a base scores, you may play this card.', subtype: 'neither', discard: 'yes' },
      { id: 'pirate_powderkeg_1', name: 'Powderkeg', type: 'action', count: 1, ability: 'Destroy one of your minions and all minions with equal or less power on the same base.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'pirate_sea_dogs_1', name: 'Sea Dogs', type: 'action', count: 1, ability: 'Name a faction. Move all other players\' minions of that faction from one base to another.', subtype: 'base', discard: 'yes' },
      { id: 'pirate_shanghai_1', name: 'Shanghai', type: 'action', count: 1, ability: 'Move another player\'s minion to another base.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'pirate_swashbuckling_1', name: 'Swashbuckling', type: 'action', count: 1, ability: 'Each of your minions gains +1 power until the end of the turn.', subtype: 'neither', discard: 'yes' }
    ]
  },
  Robots: {
    name: "Robots",
    cards: [
      // Minions (Total: 18)
      { id: 'robot_nukebot_1', name: 'Nukebot', type: 'minion', power: 5, count: 1, ability: 'Ongoing: After this minion is destroyed, destroy each other player\'s minions on this base.', subtype: 'base', discard: 'no' },
      { id: 'robot_warbot_1', name: 'Warbot', type: 'minion', power: 4, count: 2, ability: 'Ongoing: This minion cannot be destroyed.', subtype: 'base', discard: 'no' },
      { id: 'robot_hoverbot_1', name: 'Hoverbot', type: 'minion', power: 3, count: 3, ability: 'Reveal the top card of your deck. If it is a minion, you may play it as an extra minion. Otherwise, return it to the top of your deck.', subtype: 'base', discard: 'no' },
      { id: 'robot_zapbot_1', name: 'Zapbot', type: 'minion', power: 2, count: 4, ability: 'You may play an extra minion of power 2 or less.', subtype: 'base', discard: 'no' },
      { id: 'robot_microbot_alpha_1', name: 'Microbot Alpha', type: 'minion', power: 1, count: 1, ability: 'Ongoing: Gains +1 power for each of your other Microbots. All of your minions are considered Microbots.', subtype: 'base', discard: 'no' },
      { id: 'robot_microbot_archive_1', name: 'Microbot Archive', type: 'minion', power: 1, count: 1, ability: 'Ongoing: After one of your Microbots (including this one) is destroyed, draw a card.', subtype: 'base', discard: 'no' },
      { id: 'robot_microbot_fixer_1', name: 'Microbot Fixer', type: 'minion', power: 1, count: 2, ability: 'If this is the first minion you played this turn, you may play an extra minion. Ongoing: Each of your Microbots gains +1 power.', subtype: 'base', discard: 'no' },
      { id: 'robot_microbot_guard_1', name: 'Microbot Guard', type: 'minion', power: 1, count: 2, ability: 'Destroy a minion on this base with power less than the number of minions you have here.', subtype: 'base', discard: 'no' },
      { id: 'robot_microbot_reclaimer_1', name: 'Microbot Reclaimer', type: 'minion', power: 1, count: 2, ability: 'If this is the first minion you played this turn, you may play an extra minion. Shuffle any number of Microbots from your discard pile into your deck.', subtype: 'base', discard: 'no' },

      // Actions (Total: 2)
      { id: 'robot_tech_center_1', name: 'Tech Center', type: 'action', count: 2, ability: 'Choose a base. Draw one card for each of your minions there.', subtype: 'base', discard: 'yes' }
    ]
  },
  Wizards: {
    name: "Wizards",
    cards: [
      // Minions (Total: 10)
      { id: 'wizard_archmage_1', name: 'Archmage', type: 'minion', power: 4, count: 1, ability: 'Talent: Play an extra action.', subtype: 'base', discard: 'no' },
      { id: 'wizard_chronomage_1', name: 'Chronomage', type: 'minion', power: 3, count: 2, ability: 'You may play an extra action this turn.', subtype: 'base', discard: 'no' },
      { id: 'wizard_enchantress_1', name: 'Enchantress', type: 'minion', power: 2, count: 3, ability: 'Draw a card.', subtype: 'base', discard: 'no' },
      { id: 'wizard_neophyte_1', name: 'Neophyte', type: 'minion', power: 2, count: 4, ability: 'Reveal the top card of your deck. If it is an action, you may place it in your hand or play it as an extra action. Otherwise, return it to the top of your deck.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'wizard_mass_enchantment_1', name: 'Mass Enchantment', type: 'action', count: 1, ability: 'Reveal the top card of each other player’s deck. You may play one revealed action as an extra action. Return unused cards to the top of their decks.', subtype: 'neither', discard: 'yes' },
      { id: 'wizard_mystic_studies_1', name: 'Mystic Studies', type: 'action', count: 2, ability: 'Draw two cards.', subtype: 'neither', discard: 'yes' },
      { id: 'wizard_portal_1', name: 'Portal', type: 'action', count: 1, ability: 'Reveal the top five cards of your deck. You may place any number of minions you revealed into your hand. Return the other cards to the top of your deck in any order.', subtype: 'neither', discard: 'yes' },
      { id: 'wizard_sacrifice_1', name: 'Sacrifice', type: 'action', count: 1, ability: 'Choose one of your minions. Draw cards equal to its power. Destroy that minion.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'wizard_scry_1', name: 'Scry', type: 'action', count: 1, ability: 'Search your deck for an action. Reveal it and place it into your hand. Shuffle your deck.', subtype: 'neither', discard: 'yes' },
      { id: 'wizard_summon_1', name: 'Summon', type: 'action', count: 2, ability: 'Play an extra minion.', subtype: 'neither', discard: 'yes' },
      { id: 'wizard_time_loop_1', name: 'Time Loop', type: 'action', count: 1, ability: 'Play two extra actions.', subtype: 'neither', discard: 'yes' },
      { id: 'wizard_winds_of_change_1', name: 'Winds of Change', type: 'action', count: 1, ability: 'Shuffle your hand into your deck and draw five cards. You may play an extra action.', subtype: 'neither', discard: 'yes' }
    ]
  },
  Zombies: {
    name: "Zombies",
    cards: [
      // Minions (Total: 10)
      { id: 'zombie_lord_1', name: 'Zombie Lord', type: 'minion', power: 5, count: 1, ability: 'You may play an extra minion of power 2 or less from your discard pile on each base where you have no minions.', subtype: 'base', discard: 'no' },
      { id: 'zombie_grave_digger_1', name: 'Grave Digger', type: 'minion', power: 4, count: 2, ability: 'You may place a minion from your discard pile into your hand.', subtype: 'base', discard: 'no' },
      { id: 'zombie_tenacious_z_1', name: 'Tenacious Z', type: 'minion', power: 2, count: 3, ability: 'Special: On your turn you may play this card from your discard pile as an extra minion. You may only use the ability of one Tenacious Z each turn.', subtype: 'base', discard: 'no' },
      { id: 'zombie_walker_1', name: 'Walker', type: 'minion', power: 2, count: 4, ability: 'Look at the top card of your deck. Discard it or return it to the top of your deck.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'zombie_grave_robbing_1', name: 'Grave Robbing', type: 'action', count: 2, ability: 'Place a card from your discard pile into your hand.', subtype: 'neither', discard: 'yes' },
      { id: 'zombie_lend_a_hand_1', name: 'Lend a Hand', type: 'action', count: 1, ability: 'Shuffle any number of cards from your discard pile into your deck.', subtype: 'neither', discard: 'yes' },
      { id: 'zombie_mall_crawl_1', name: 'Mall Crawl', type: 'action', count: 1, ability: 'Search your deck for any number of cards with the same name and place them into your discard pile. Shuffle your deck.', subtype: 'neither', discard: 'yes' },
      { id: 'zombie_not_enough_bullets_1', name: 'Not Enough Bullets', type: 'action', count: 1, ability: 'Place any number of minions with the same name from your discard pile into your hand.', subtype: 'neither', discard: 'yes' },
      { id: 'zombie_outbreak_1', name: 'Outbreak', type: 'action', count: 1, ability: 'Play an extra minion on a base where you have no minions.', subtype: 'neither', discard: 'yes' },
      { id: 'zombie_overrun_1', name: 'Overrun', type: 'action', count: 1, ability: 'Play on a base. Ongoing: Other players cannot play minions on this base. Destroy this action at the start of your turn.', subtype: 'base', discard: 'no' },
      { id: 'zombie_they_keep_coming_1', name: 'They Keep Coming', type: 'action', count: 2, ability: 'Play an extra minion from your discard pile.', subtype: 'neither', discard: 'yes' },
      { id: 'zombie_they_re_coming_to_get_you_1', name: "They're Coming To Get You", type: 'action', count: 1, ability: 'Play on a base. Ongoing: Once on your turn, you may play a minion here from your discard pile instead of from your hand.', subtype: 'base', discard: 'no' }
    ]
  }
};

// Declarative rules data. `ability` above remains the player-facing card text;
// these definitions are the server-facing source for a future rules resolver.
const ability = (trigger, effects, options = {}) => ({
  trigger,
  effects: Array.isArray(effects) ? effects : [effects],
  ...options
});

const abilityDefinitions = {
  // Dinosaurs
  dino_war_raptor_1: [ability('ongoing', { type: 'modifyPower', target: 'self', amount: { type: 'countMinions', cardId: 'dino_war_raptor_1', location: 'sameBase' }, duration: 'whileInPlay' })],
  dino_bro_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBase', power: { max: 2 } } }, { optional: true })],
  dino_king_1: [],
  dino_armor_1: [ability('ongoing', { type: 'modifyPower', target: 'self', amount: 2, activeDuring: 'otherPlayersTurns', duration: 'whileInPlay' })],
  dino_howl_1: [ability('onPlay', { type: 'modifyPower', target: { kind: 'minion', owner: 'controller', location: 'inPlay', quantity: 'all' }, amount: 1, duration: 'untilEndOfOwnersTurn' })],
  dino_augmentation_1: [ability('onPlay', { type: 'modifyPower', target: 'selectedMinion', amount: 4, duration: 'untilEndOfTurn' })],
  dino_tooth_1: [ability('ongoing', { type: 'grantProtection', target: 'attachedTo', protection: { from: 'otherPlayersCards' }, duration: 'whileAttached' })],
  dino_upgrade_1: [ability('ongoing', { type: 'modifyPower', target: 'attachedTo', amount: 2, duration: 'whileAttached' })],
  dino_wildlife_preserve_1: [ability('ongoing', { type: 'grantProtection', target: { kind: 'minion', owner: 'controller', location: 'attachedBase' }, protection: { from: 'otherPlayersActions' }, duration: 'whileAttached' })],
  dino_natural_selection_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBaseAsSelectedMinion', power: { lessThan: 'selectedMinion' } } })],
  dino_rampage_1: [ability('onPlay', { type: 'modifyBreakpoint', target: 'baseOfSelectedMinion', amount: { type: 'negativePowerOf', target: 'selectedMinion' }, duration: 'untilEndOfTurn' })],
  dino_survival_1: [ability('onPlay', { type: 'destroyLowestPowerMinion', target: { kind: 'base', filter: 'hasHigherPowerMinion' }, tieBreaker: 'controllerChooses' })],

  // Aliens
  alien_supreme_overlord_1: [ability('onPlay', { type: 'returnToHand', target: { kind: 'minion', owner: 'any' } }, { optional: true })],
  alien_invader_1: [ability('onPlay', { type: 'gainVictoryPoints', target: 'controller', amount: 1 })],
  alien_scout_1: [ability('afterBaseScoring', { type: 'returnToHand', target: 'self' }, { optional: true })],
  alien_collector_1: [ability('onPlay', { type: 'returnToHand', target: { kind: 'minion', location: 'sameBase', power: { max: 3 } } }, { optional: true })],
  alien_abduction_1: [ability('onPlay', [{ type: 'returnToHand', target: 'selectedMinion' }, { type: 'grantExtraPlay', cardType: 'minion', amount: 1, duration: 'thisTurn' }])],
  alien_beam_up_1: [ability('onPlay', { type: 'returnToHand', target: 'selectedMinion' })],
  alien_crop_circles_1: [ability('onPlay', { type: 'returnToHand', target: { kind: 'minion', location: 'selectedBase', owner: 'any', quantity: 'all' } })],
  alien_disintegrator_1: [ability('onPlay', { type: 'moveToDeck', target: { kind: 'minion', power: { max: 3 } }, position: 'bottom' })],
  alien_invasion_1: [ability('onPlay', { type: 'moveMinion', target: 'selectedMinion', destination: { kind: 'base', relation: 'another' } })],
  alien_jammed_signal_1: [ability('ongoing', { type: 'cancelBaseAbilities', target: 'attachedBase', duration: 'whileAttached' })],
  alien_probe_1: [ability('onPlay', [{ type: 'revealHand', target: { kind: 'player', relation: 'other' } }, { type: 'discardFromHand', target: { kind: 'minion', owner: 'selectedPlayer' } }])],
  alien_terraforming_1: [ability('onPlay', [{ type: 'swapBaseFromDeck', target: 'selectedBase' }, { type: 'grantExtraPlay', cardType: 'minion', amount: 1, destination: 'replacementBase', duration: 'thisTurn' }])],

  // Ninjas
  ninja_master_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBase' } }, { optional: true })],
  ninja_tiger_assassin_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBase', power: { max: 3 } } }, { optional: true })],
  ninja_shinobi_1: [ability('beforeBaseScoring', { type: 'playFromHand', card: 'self', destination: 'scoringBase' }, { optional: true, limit: { scope: 'base', key: 'ninja_shinobi', maxUses: 1 } })],
  ninja_acolyte_1: [ability('talent', [{ type: 'returnToHand', target: 'self' }, { type: 'grantExtraPlay', cardType: 'minion', amount: 1, destination: 'sameBase' }], { condition: { turnState: { minionPlayed: false } } })],
  ninja_assassination_1: [ability('endTurn', { type: 'destroyMinion', target: 'attachedTo' })],
  ninja_disguise_1: [ability('onPlay', [{ type: 'grantExtraPlay', cardType: 'minion', amount: { type: 'selectedCount' }, destination: 'selectedBase' }, { type: 'returnToHand', target: { kind: 'minion', owner: 'controller', selected: true, quantity: { min: 1, max: 2 } } }])],
  ninja_hidden_ninja_1: [ability('beforeBaseScoring', { type: 'playMinionFromHand', destination: 'scoringBase' }, { optional: true })],
  ninja_infiltrate_1: [ability('ongoing', { type: 'ignoreBaseAbility', target: 'controller', base: 'attachedBase', duration: 'whileAttached' }), ability('startTurn', { type: 'destroyAction', target: 'self' })],
  ninja_poison_1: [ability('onPlay', { type: 'destroyAction', target: { kind: 'action', location: 'attachedTo', quantity: 'any' } }, { optional: true }), ability('ongoing', { type: 'modifyPower', target: 'attachedTo', amount: -4, minimum: 0, duration: 'whileAttached' })],
  ninja_seeing_stars_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', power: { max: 3 } } })],
  ninja_smoke_bomb_1: [ability('ongoing', { type: 'grantProtection', target: 'attachedTo', protection: { from: 'otherPlayersActions' }, duration: 'whileAttached' })],
  ninja_way_of_deception_1: [ability('onPlay', { type: 'moveMinion', target: 'selectedMinion', destination: { kind: 'base', relation: 'another' } })],

  // Pirates
  pirate_king_1: [ability('beforeBaseScoring', { type: 'moveMinion', target: 'self', destination: 'scoringBase' }, { optional: true })],
  pirate_buccaneer_1: [ability('wouldBeDestroyed', { type: 'moveMinion', target: 'self', destination: { kind: 'base', relation: 'another' }, replacementFor: 'destroy' }, { optional: true, limit: { scope: 'turn', maxUses: 1 } })],
  pirate_cut_lass_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBase', power: { max: 2 } } }, { optional: true })],
  pirate_first_mate_1: [ability('afterBaseScoring', { type: 'moveMinion', target: 'self', destination: { kind: 'base', relation: 'another' }, replacementFor: 'discard' }, { optional: true })],
  pirate_broadside_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', owner: 'selectedPlayer', location: 'selectedBase', power: { max: 2 }, quantity: 'all' }, condition: { controllerHasMinionAt: 'selectedBase' } })],
  pirate_cannon_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', power: { max: 2 }, quantity: { max: 2 } } })],
  pirate_dinghy_1: [ability('onPlay', { type: 'moveMinion', target: { kind: 'minion', owner: 'controller', quantity: { max: 2 } }, destination: { kind: 'base', relation: 'another', perTarget: true } })],
  pirate_full_sail_1: [ability('onPlay', { type: 'moveMinion', target: { kind: 'minion', owner: 'controller', quantity: 'any' }, destination: { kind: 'base', relation: 'another', perTarget: true } }), ability('beforeBaseScoring', { type: 'moveMinion', target: { kind: 'minion', owner: 'controller', quantity: 'any' }, destination: { kind: 'base', relation: 'another', perTarget: true } }, { optional: true })],
  pirate_powderkeg_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBaseAsSelectedMinion', power: { max: 'selectedMinion' }, quantity: 'all', include: 'selectedMinion' } })],
  pirate_sea_dogs_1: [ability('onPlay', { type: 'moveMinion', target: { kind: 'minion', owner: 'otherPlayers', faction: 'namedFaction', location: 'selectedBase', quantity: 'all' }, destination: { kind: 'base', relation: 'another' } })],
  pirate_shanghai_1: [ability('onPlay', { type: 'moveMinion', target: { kind: 'minion', owner: 'otherPlayer' }, destination: { kind: 'base', relation: 'another' } })],
  pirate_swashbuckling_1: [ability('onPlay', { type: 'modifyPower', target: { kind: 'minion', owner: 'controller', quantity: 'all' }, amount: 1, duration: 'untilEndOfTurn' })],

  // Robots
  robot_nukebot_1: [ability('afterDestroyed', { type: 'destroyMinion', target: { kind: 'minion', owner: 'otherPlayers', location: 'formerBase', quantity: 'all' } })],
  robot_warbot_1: [ability('ongoing', { type: 'grantProtection', target: 'self', protection: { from: 'destroy' }, duration: 'whileInPlay' })],
  robot_hoverbot_1: [ability('onPlay', { type: 'revealTopDeckCard', target: 'controller', resolve: { if: { cardType: 'minion' }, then: { type: 'playRevealedCard', cardType: 'minion', extra: true }, otherwise: { type: 'returnRevealedCardToDeckTop' } } }, { optional: true })],
  robot_zapbot_1: [ability('onPlay', { type: 'grantExtraPlay', cardType: 'minion', maxPower: 2, amount: 1, duration: 'thisTurn' }, { optional: true })],
  robot_microbot_alpha_1: [ability('ongoing', [{ type: 'addTrait', target: { kind: 'minion', owner: 'controller', quantity: 'all' }, trait: 'Microbot', duration: 'whileInPlay' }, { type: 'modifyPower', target: 'self', amount: { type: 'countMinionsWithTrait', trait: 'Microbot', owner: 'controller', excludeSelf: true }, duration: 'whileInPlay' }])],
  robot_microbot_archive_1: [ability('afterDestroyed', { type: 'drawCards', target: 'controller', amount: 1 }, { condition: { destroyedCard: { trait: 'Microbot', includeSelf: true } }, optional: true })],
  robot_microbot_fixer_1: [ability('onPlay', { type: 'grantExtraPlay', cardType: 'minion', amount: 1, duration: 'thisTurn' }, { optional: true, condition: { turnState: { minionsPlayed: 1 } } }), ability('ongoing', { type: 'modifyPower', target: { kind: 'minion', owner: 'controller', trait: 'Microbot', quantity: 'all' }, amount: 1, duration: 'whileInPlay' })],
  robot_microbot_guard_1: [ability('onPlay', { type: 'destroyMinion', target: { kind: 'minion', location: 'sameBase', power: { lessThan: { type: 'countMinions', owner: 'controller', location: 'sameBase' } } } })],
  robot_microbot_reclaimer_1: [ability('onPlay', [{ type: 'grantExtraPlay', cardType: 'minion', amount: 1, duration: 'thisTurn' }, { type: 'shuffleDiscardIntoDeck', target: { kind: 'card', owner: 'controller', trait: 'Microbot', quantity: 'any' } }], { optional: true, condition: { turnState: { minionsPlayed: 1 } } })],
  robot_tech_center_1: [ability('onPlay', { type: 'drawCards', target: 'controller', amount: { type: 'countMinions', owner: 'controller', location: 'selectedBase' } })],

  // Wizards
  wizard_archmage_1: [ability('talent', { type: 'grantExtraPlay', cardType: 'action', amount: 1, duration: 'thisTurn' })],
  wizard_chronomage_1: [ability('onPlay', { type: 'grantExtraPlay', cardType: 'action', amount: 1, duration: 'thisTurn' }, { optional: true })],
  wizard_enchantress_1: [ability('onPlay', { type: 'drawCards', target: 'controller', amount: 1 })],
  wizard_neophyte_1: [ability('onPlay', { type: 'revealTopDeckCard', target: 'controller', resolve: { if: { cardType: 'action' }, then: { type: 'choose', options: [{ type: 'moveRevealedCardToHand' }, { type: 'playRevealedCard', cardType: 'action', extra: true }] }, otherwise: { type: 'returnRevealedCardToDeckTop' } } }, { optional: true })],
  wizard_mass_enchantment_1: [ability('onPlay', { type: 'revealTopDeckCard', target: { kind: 'player', relation: 'other', quantity: 'all' }, resolve: { type: 'playOneRevealedCard', cardType: 'action', extra: true, returnUnusedToTop: true } })],
  wizard_mystic_studies_1: [ability('onPlay', { type: 'drawCards', target: 'controller', amount: 2 })],
  wizard_portal_1: [ability('onPlay', { type: 'revealDeckCards', target: 'controller', amount: 5, resolve: { type: 'moveSelectedRevealedCardsToHand', cardType: 'minion', returnUnselectedToTopInOrder: true } })],
  wizard_sacrifice_1: [ability('onPlay', [{ type: 'drawCards', target: 'controller', amount: { type: 'powerOf', target: 'selectedMinion' } }, { type: 'destroyMinion', target: 'selectedMinion' }])],
  wizard_scry_1: [ability('onPlay', { type: 'searchDeck', target: 'controller', cardType: 'action', resolve: { type: 'revealSelectedCard', then: { type: 'moveSelectedCardToHand' }, shuffleAfter: true } })],
  wizard_summon_1: [ability('onPlay', { type: 'grantExtraPlay', cardType: 'minion', amount: 1, duration: 'thisTurn' })],
  wizard_time_loop_1: [ability('onPlay', { type: 'grantExtraPlay', cardType: 'action', amount: 2, duration: 'thisTurn' })],
  wizard_winds_of_change_1: [ability('onPlay', [{ type: 'shuffleHandIntoDeck', target: 'controller' }, { type: 'drawCards', target: 'controller', amount: 5 }, { type: 'grantExtraPlay', cardType: 'action', amount: 1, duration: 'thisTurn' }])],

  // Zombies
  zombie_lord_1: [ability('onPlay', { type: 'playFromDiscard', cardType: 'minion', maxPower: 2, destination: { kind: 'base', filter: 'controllerHasNoMinions', quantity: 'each' }, extra: true }, { optional: true })],
  zombie_grave_digger_1: [ability('onPlay', { type: 'moveFromDiscardToHand', target: { kind: 'minion', owner: 'controller' } }, { optional: true })],
  zombie_tenacious_z_1: [ability('duringOwnersPlayCardsPhase', { type: 'playFromDiscard', card: 'self', cardType: 'minion', extra: true }, { optional: true, limit: { scope: 'turn', key: 'tenacious-z', maxUses: 1 } })],
  zombie_walker_1: [ability('onPlay', { type: 'revealTopDeckCard', target: 'controller', resolve: { type: 'choose', options: [{ type: 'discardRevealedCard' }, { type: 'returnRevealedCardToDeckTop' }] } }, { optional: true })],
  zombie_grave_robbing_1: [ability('onPlay', { type: 'moveFromDiscardToHand', target: { kind: 'card', owner: 'controller' } })],
  zombie_lend_a_hand_1: [ability('onPlay', { type: 'shuffleDiscardIntoDeck', target: { kind: 'card', owner: 'controller', quantity: 'any' } })],
  zombie_mall_crawl_1: [ability('onPlay', { type: 'searchDeck', target: 'controller', resolve: { type: 'moveCardsWithSelectedNameToDiscard', quantity: 'any', shuffleAfter: true } })],
  zombie_not_enough_bullets_1: [ability('onPlay', { type: 'moveFromDiscardToHand', target: { kind: 'minion', owner: 'controller', sameNameAs: 'selectedCard', quantity: 'any' } })],
  zombie_outbreak_1: [ability('onPlay', { type: 'grantExtraPlay', cardType: 'minion', amount: 1, destination: { kind: 'base', filter: 'controllerHasNoMinions' }, duration: 'thisTurn' })],
  zombie_overrun_1: [ability('ongoing', { type: 'preventPlay', target: { kind: 'minion', owner: 'otherPlayers', location: 'attachedBase' }, duration: 'whileAttached' }), ability('startTurn', { type: 'destroyAction', target: 'self' })],
  zombie_they_keep_coming_1: [ability('onPlay', { type: 'grantExtraPlayFromDiscard', cardType: 'minion', amount: 1, duration: 'thisTurn' })],
  zombie_they_re_coming_to_get_you_1: [ability('ongoing', { type: 'grantDiscardPlayPermission', cardType: 'minion', destination: 'attachedBase', replacementFor: 'playFromHand', limit: { scope: 'turn', maxUses: 1 } })]
};

for (const faction of Object.values(factionsData)) {
  faction.factionEntityId = getFactionEntityId(faction.name);
  for (const card of faction.cards) {
    card.cardEntityId = getCardEntityId(card.id);
    card.abilities = abilityDefinitions[card.id] ?? [];
  }
}

function buildFactionDeck(factionKey, random = systemRandom) {
  const faction = factionsData[factionKey];
  if (!faction) return [];

  let deck = [];
  faction.cards.forEach(cardTemplate => {
    for (let i = 0; i < cardTemplate.count; i++) {
      deck.push({
        instanceId: `${cardTemplate.id}_${random().toString(36).slice(2, 7)}`,
        cardId: cardTemplate.id,
        cardEntityId: cardTemplate.cardEntityId,
        name: cardTemplate.name,
        type: cardTemplate.type,
        subtype: cardTemplate.subtype,
        power: cardTemplate.power,
        printedPower: cardTemplate.power,
        ability: cardTemplate.ability,
        abilities: cardTemplate.abilities,
        faction: faction.name,
        factionEntityId: faction.factionEntityId,
        discard: cardTemplate.discard
      });
    }
  });

  if (deck.length > 20) {
    deck = deck.slice(0, 20);
  }

  return deck;
}

module.exports = { factionsData, buildFactionDeck };
