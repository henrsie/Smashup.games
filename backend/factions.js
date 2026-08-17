// backend/factions.js

const factionsData = {
  Dinosaurs: {
    name: "Dinosaurs",
    cards: [
      // Minions (Total: 10)
      { id: 'dino_war_raptor_1', name: 'War Raptor', type: 'minion', power: 3, count: 4, ability: 'Ongoing: This minion gains +1 power for each other War Raptor at this base.', subtype: 'base', discard: 'no' },
      { id: 'dino_bro_1', name: 'Laseratops', type: 'minion', power: 4, count: 2, ability: 'Ongoing: You may destroy a minion here of printed power 2 or less.', subtype: 'base', discard: 'no' },
      { id: 'dino_king_1', name: 'King Rex', type: 'minion', power: 7, count: 1, ability: '', subtype: 'base', discard: 'no' },
      { id: 'dino_armor_1', name: 'Armor Stego', type: 'minion', power: 3, count: 3, ability: 'Talent: Until the start of your next turn, this minion gets +2 power.', subtype: 'base', discard: 'no' },

      // actions (Total: 10)
      { id: 'dino_howl_1', name: 'Howl', type: 'action', count: 2, ability: 'Choose a base: each of your minions gets +1 power until the end of the turn.', subtype: 'base', discard: 'yes' },
      { id: 'dino_augmentation_1', name: 'Augmentation', type: 'action', count: 2, ability: 'Give a minion +4 power until the end of the turn.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'dino_tooth_1', name: ' Tooth and Claw', type: 'action', count: 1, ability: 'Play on a minion. Ongoing: This minion is not affected by any cards played by other players.', subtype: 'ally-minion', discard: 'no' },
      { id: 'dino_upgrade_1', name: ' Upgrade', type: 'action', count: 1, ability: 'Play on a minion. Ongoing: This minion has +2 power.', subtype: 'ally-minion', discard: 'no' },
      { id: 'dino_wildlife_preserve_1', name: ' Wildlife Preserve', type: 'action', count: 1, ability: 'Play on a base. Ongoing: Your minions here are not affected by other players’ actions.', subtype: 'base', discard: 'no' },
      { id: 'dino_natural_selection_1', name: ' Natural Selection', type: 'action', count: 1, ability: 'Choose one of your minions on a base. Destroy a minion there with less power than yours. ', subtype: 'ally-minion', discard: 'yes' },
      { id: 'dino_rampage_1', name: ' Rampage', type: 'action', count: 1, ability: 'Reduce the breakpoint of a base by the power of one of your minions on that base until the end of the turn.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'dino_survival_1', name: ' Survival of the Fittest', type: 'action', count: 1, ability: 'Destroy the lowest-power minion (you choose in case of a tie) on each base with a higher-power minion.', subtype: 'neither', discard: 'no' }
    ]
  },
  Aliens: {
    name: "Aliens",
    cards: [
      // Minions (Total: 10)
      { id: 'alien_supreme_overlord_1', name: 'Supreme Overlord', type: 'minion', power: 5, count: 1, ability: 'When this minion is played, you may return a minion to its owner\'s hand.', subtype: 'base', discard: 'no' },
      { id: 'alien_invader_1', name: 'Invader', type: 'minion', power: 3, count: 2, ability: 'Gain 1 VP.', subtype: 'base', discard: 'no' },
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
      { id: 'alien_terraforming_1', name: 'Terraforming', type: 'action', count: 1, ability: 'Search the base deck for a base and swap it with a base in play. You may play an extra minion there.', subtype: 'base-swap', discard: 'yes' }
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
      { id: 'ninja_hidden_ninja_1', name: 'Hidden Ninja', type: 'action', count: 1, ability: 'Special: Before a base scores, play a minion there.', subtype: 'neither', discard: 'no' },
      { id: 'ninja_infiltrate_1', name: 'Infiltrate', type: 'action', count: 2, ability: 'Play on a base. You may destroy another action on this base. Talent: Destroy this action to cancel this base\'s ability until the start of your turn.', subtype: 'base', discard: 'no' },
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
      { id: 'pirate_broadside_1', name: 'Broadside', type: 'action', count: 2, ability: 'Destroy all of one player\'s minions of power 2 or less on a base where you have a minion.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'pirate_cannon_1', name: 'Cannon', type: 'action', count: 1, ability: 'Destroy up to two minions of power 2 or less.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'pirate_dinghy_1', name: 'Dinghy', type: 'action', count: 2, ability: 'Move up to two of your minions to other bases.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'pirate_full_sail_1', name: 'Full Sail', type: 'action', count: 1, ability: 'Special: Before a base scores, you may play this card. Move any number of your minions to other bases.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'pirate_powderkeg_1', name: 'Powderkeg', type: 'action', count: 1, ability: 'Destroy one of your minions and all minions with equal or less power on the same base.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'pirate_sea_dogs_1', name: 'Sea Dogs', type: 'action', count: 1, ability: 'Name a faction. Move all other players\' minions of that faction from one base to another.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'pirate_shanghai_1', name: 'Shanghai', type: 'action', count: 1, ability: 'Move another player\'s minion to another base.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'pirate_swashbuckling_1', name: 'Swashbuckling', type: 'action', count: 1, ability: 'Each of your minions gains +1 power until the end of the turn.', subtype: 'ally-minion', discard: 'yes' }
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
      { id: 'robot_microbot_guard_1', name: 'Microbot Guard', type: 'minion', power: 1, count: 2, ability: 'Destroy a minion on this base with power less than the number of minions you have here.', subtype: 'enemy-minion', discard: 'yes' },
      { id: 'robot_microbot_reclaimer_1', name: 'Microbot Reclaimer', type: 'minion', power: 1, count: 2, ability: 'If this is the first minion you played this turn, you may play an extra minion. Shuffle any number of Microbots from your discard pile into your deck.', subtype: 'base', discard: 'no' },

      // Actions (Total: 2)
      { id: 'robot_tech_center_1', name: 'Tech Center', type: 'action', count: 2, ability: 'Choose a base. Draw one card for each of your minions there.', subtype: 'base', discard: 'no' }
    ]
  },
  Wizards: {
    name: "Wizards",
    cards: [
      // Minions (Total: 10)
      { id: 'wizard_archmage_1', name: 'Archmage', type: 'minion', power: 4, count: 1, ability: 'Ongoing: You may play an extra action on each of your turns.', subtype: 'base', discard: 'no' },
      { id: 'wizard_archmage_2', name: 'Archmage', type: 'minion', power: 4, count: 1, ability: 'Talent: Play an extra action.', subtype: 'base', discard: 'no' },
      { id: 'wizard_chronomage_1', name: 'Chronomage', type: 'minion', power: 3, count: 2, ability: 'You may play an extra action this turn.', subtype: 'base', discard: 'no' },
      { id: 'wizard_enchantress_1', name: 'Enchantress', type: 'minion', power: 2, count: 3, ability: 'Draw a card.', subtype: 'base', discard: 'no' },
      { id: 'wizard_neophyte_1', name: 'Neophyte', type: 'minion', power: 2, count: 4, ability: 'Reveal the top card of your deck. If it is an action, you may place it in your hand or play it as an extra action. Otherwise, return it to the top of your deck.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'wizard_mass_enchantment_1', name: 'Mass Enchantment', type: 'action', count: 1, ability: 'Reveal the top card of each other player’s deck. Play one revealed action as an extra action. Return unused cards to the top of their decks.', subtype: 'neither', discard: 'no' },
      { id: 'wizard_mystic_studies_1', name: 'Mystic Studies', type: 'action', count: 2, ability: 'Draw two cards.', subtype: 'neither', discard: 'no' },
      { id: 'wizard_portal_1', name: 'Portal', type: 'action', count: 1, ability: 'Reveal the top five cards of your deck. Place any number of minions revealed into your hand. Return the other cards to the top of your deck in any order.', subtype: 'neither', discard: 'no' },
      { id: 'wizard_sacrifice_1', name: 'Sacrifice', type: 'action', count: 1, ability: 'Choose one of your minions. Draw cards equal to its power. Destroy that minion.', subtype: 'ally-minion', discard: 'yes' },
      { id: 'wizard_scry_1', name: 'Scry', type: 'action', count: 1, ability: 'Search your deck for an action and reveal it to all players. Place it into your hand and shuffle your deck.', subtype: 'neither', discard: 'no' },
      { id: 'wizard_summon_1', name: 'Summon', type: 'action', count: 2, ability: 'Play an extra minion.', subtype: 'neither', discard: 'no' },
      { id: 'wizard_time_loop_1', name: 'Time Loop', type: 'action', count: 1, ability: 'Play two extra actions.', subtype: 'neither', discard: 'no' },
      { id: 'wizard_winds_of_change_1', name: 'Winds of Change', type: 'action', count: 1, ability: 'Shuffle your hand into your deck and draw five cards. You may play an extra action.', subtype: 'neither', discard: 'no' }
    ]
  },
  Zombies: {
    name: "Zombies",
    cards: [
      // Minions (Total: 10)
      { id: 'zombie_lord_1', name: 'Zombie Lord', type: 'minion', power: 5, count: 1, ability: 'You may play an extra minion of power 2 or less from your discard pile on each base where you have no minions.', subtype: 'base', discard: 'no' },
      { id: 'zombie_grave_digger_1', name: 'Grave Digger', type: 'minion', power: 4, count: 2, ability: 'You may place a minion from your discard pile into your hand.', subtype: 'base', discard: 'no' },
      { id: 'zombie_tenacious_z_1', name: 'Tenacious Z', type: 'minion', power: 2, count: 3, ability: 'Special: During your turn you may play this card from your discard pile as an extra minion. You may only use the ability of one Tenacious Z each turn.', subtype: 'base', discard: 'no' },
      { id: 'zombie_walker_1', name: 'Walker', type: 'minion', power: 2, count: 4, ability: 'Look at the top card of your deck. Discard it or return it to the top of your deck.', subtype: 'base', discard: 'no' },

      // Actions (Total: 10)
      { id: 'zombie_grave_robbing_1', name: 'Grave Robbing', type: 'action', count: 2, ability: 'Place a card from your discard pile into your hand.', subtype: 'neither', discard: 'no' },
      { id: 'zombie_lend_a_hand_1', name: 'Lend a Hand', type: 'action', count: 1, ability: 'Shuffle any number of cards from your discard pile into your deck.', subtype: 'neither', discard: 'no' },
      { id: 'zombie_mall_crawl_1', name: 'Mall Crawl', type: 'action', count: 1, ability: 'Search your deck for any number of cards with the same name and place them into your discard pile. Shuffle your deck.', subtype: 'neither', discard: 'no' },
      { id: 'zombie_not_enough_bullets_1', name: 'Not Enough Bullets', type: 'action', count: 1, ability: 'Place any number of minions with the same name from your discard pile into your hand.', subtype: 'neither', discard: 'no' },
      { id: 'zombie_outbreak_1', name: 'Outbreak', type: 'action', count: 1, ability: 'Play an extra minion on a base where you have no minions.', subtype: 'neither', discard: 'no' },
      { id: 'zombie_overrun_1', name: 'Overrun', type: 'action', count: 1, ability: 'Play on a base. Ongoing: Other players cannot play minions on this base. Destroy this action at the start of your turn.', subtype: 'base', discard: 'no' },
      { id: 'zombie_they_keep_coming_1', name: 'They Keep Coming', type: 'action', count: 2, ability: 'Play an extra minion from your discard pile.', subtype: 'neither', discard: 'no' },
      { id: 'zombie_they_re_coming_to_get_you_1', name: "They're Coming To Get You", type: 'action', count: 1, ability: 'Play on a base. Ongoing: Once on your turn, you may play a minion here from your discard pile instead of from your hand.', subtype: 'base', discard: 'no' }
    ]
  }
};

function buildFactionDeck(factionKey) {
  const faction = factionsData[factionKey];
  if (!faction) return [];

  let deck = [];
  faction.cards.forEach(cardTemplate => {
    for (let i = 0; i < cardTemplate.count; i++) {
      deck.push({
        instanceId: `${cardTemplate.id}_${Math.random().toString(36).substr(2, 5)}`,
        name: cardTemplate.name,
        type: cardTemplate.type,
        subtype: cardTemplate.subtype,
        power: cardTemplate.power,
        ability: cardTemplate.ability,
        faction: faction.name,
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