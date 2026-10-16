/**
 * glossary.js - what the game's words mean, in Raphael's own explanations
 * (16 Oct 2026), written for players. Used in two places so they always say
 * the same:
 *   - the small ⓘ next to a word on an NFT's detail page (NftCard.js):
 *     `short`, on hover (website) or tap;
 *   - Ask Devi's "Devikin words" answers (HelpAssistant.js): `short` plus
 *     `more`, found by `keywords`.
 * Keyed by the database column (or a section name like 'genes').
 */
export const GLOSSARY = {
  rarity: {
    title: 'Rarity',
    short: 'From lowest to highest: Common, Uncommon, Rare, Mythic, Eldritch.',
  },
  procreations_left: {
    title: 'Procreations Left',
    short: 'How many more times this Devikin can breed - at most 10 in its life. The price doubles with every breed, and Eldritch Devikins can\'t breed.',
    more: 'In the game you pair two Devikins to breed a new one. The Breeding Helper (☰ > Features) finds partners among your own Devikins and estimates the cost.',
    question: 'What is a procreation / Procreations Left?',
    keywords: ['procreation', 'procreations', 'procreate', 'breed', 'breeding', 'breeds', 'pair'],
  },
  life_stage: {
    title: 'Life Stage',
    short: 'Embryo (how you receive it, not playable yet) → Toddler (hatched; it trains and grows up in seven days, which can be sped up) → Adult (training finished).',
    question: 'What is a Life Stage (Embryo, Toddler, Adult)?',
    keywords: ['life stage', 'stage', 'embryo', 'toddler', 'adult', 'hatch', 'hatching', 'grow'],
  },
  overall_affinity: {
    title: 'Overall Affinity',
    short: 'All five Affinities added up - a quick sense of how strong a Devikin is overall.',
    question: 'What is Overall Affinity?',
    keywords: ['overall', 'overall affinity', 'total', 'strongest', 'strong'],
  },
  personality: {
    title: 'Personality',
    short: 'Each Personality adds 2 to 5 bonus points to certain Affinities - and through them to the Attributes. For example, Sassy raises Agility by 2.',
    question: 'What does Personality do?',
    keywords: ['personality', 'personalities', 'sassy', 'bonus'],
  },
  genes: {
    title: 'Genes',
    short: 'Decide how a Devikin looks (eyes, mouth, ears, hair, horns). Most are dominant, recessive or co-dominant. Themed Devikins (e.g. a Halloween edition) are usually bonded: all genes the same, so they look alike. Unique genes are themed too, but only change one or more random features.',
    question: 'What are Genes (dominant, recessive, bonded, unique)?',
    keywords: ['gene', 'genes', 'bonded', 'dominant', 'recessive', 'codominant', 'co-dominant', 'unique', 'themed'],
  },
  affinities: {
    title: 'Affinities',
    short: 'A Devikin\'s natural talent for each attribute (Vitality, Power, Fortitude, Agility, Sanity), from 1 (weak) to 10 (strong). They set the limit: a Devikin with Power 1 can\'t become very strong through training or levelling.',
    question: 'What are Affinities?',
    keywords: ['affinity', 'affinities', 'talent', 'vitality', 'power', 'fortitude', 'agility', 'sanity'],
  },
  attributes: {
    title: 'Attributes',
    short: 'How far the Affinities have actually developed - scaled from them by training (Toddler to Adult) and by levelling up from 1 to 100.',
    question: 'What are Attributes?',
    keywords: ['attribute', 'attributes', 'level', 'levelling', 'leveling', 'training', 'trained'],
  },
  quality: {
    title: 'Quality',
    short: 'How far a Weapon or Equipment has been upgraded - upgrading raises its stats.',
    question: 'What is Quality on Weapons and Equipment?',
    keywords: ['quality', 'upgrade', 'upgraded', 'upgrades', 'rusty'],
  },
};
