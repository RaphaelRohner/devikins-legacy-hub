/**
 * HelpAssistant.js
 *
 * "Devi" - a tiny, entirely offline, definitely-not-a-real-AI helper
 * built into the app. Its origin is exactly what it sounds like: asked
 * (as a joke) for "a downgraded version of you" inside the app, so this
 * is that - a chat-shaped screen that matches whatever you type against
 * a small, fixed list of canned answers about using THIS app (adding a
 * wallet, what Fetch/Update does, filters, ratings, feedback, etc.).
 * There's no language model here, no network call, no API key, nothing
 * that costs money or needs a backend - just keyword matching against
 * FAQ_ENTRIES below (see matchEntry/scoreEntry further down - it's a
 * little smarter than plain substring matching: it tolerates small
 * typos and simple word variations, e.g. "walet"/"wallets" both still
 * find the wallet answer, without needing an exact keyword substring).
 * A real AI chat (calling an actual LLM API) would need a backend
 * server to hold the API key safely and would cost real money per
 * message - a genuinely different, bigger project than this, and not
 * what this screen is (asked about directly, and kept as a free,
 * offline FAQ on purpose - see NOTES.md).
 *
 * Devi is upfront about all of this the moment you open the screen and
 * whenever it can't match your question - it should never come across
 * as more capable than it actually is.
 *
 * Every FAQ_ENTRIES question/answer pair is shown as a plain, always-
 * visible list - each answer stacked directly under its own question,
 * one after another - rather than hidden behind tappable chips you'd
 * have to try one at a time to see what's there. The free-text input at
 * the bottom still exists for anything not already covered, and typed
 * questions get their own answer appended below the list as a small
 * chat exchange.
 *
 * As the list grew past a dozen entries, a single flat list of
 * questions started reading as unstructured - no way to tell at a
 * glance what was covered without reading every question. Grouped now
 * under a handful of topic headings (see FAQ_TOPICS, right above
 * FAQ_ENTRIES) - Wallets & wallet sets, Browsing & organizing your
 * collection, When something looks off, Other tools, and Data,
 * feedback & about Devi. Purely a display grouping: the free-text
 * matching below still searches every entry regardless of topic, so
 * this doesn't change what typing a question finds.
 *
 * Same full-screen-takeover pattern as WalletManager.js/Feedback.js -
 * this is App.js's seventh "screen" (`currentScreen === 'help'`), opened
 * from the hamburger menu, with its own small round "‹" back button in
 * the top-left corner (see Feedback.js's file comment - all four of
 * these screens' back buttons were shortened from "‹ Back to Home" to
 * just the arrow, per feedback).
 */

import { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { GLOSSARY } from '../constants/glossary';

// The topics FAQ_ENTRIES below are grouped into for display (see the
// "topic" field on each entry, and the grouped render further down) -
// per feedback that one long flat list of questions read as
// unstructured, with no way to tell at a glance what's covered. Order
// here is the display order: roughly the order a new user would
// actually need these things, from getting wallets set up through to
// what to do when something looks wrong, other built-in tools, and
// finally data/feedback/about-Devi questions that apply to the app as
// a whole rather than any one screen. Purely a display grouping - it
// has no effect on keyword matching (matchEntry/scoreEntry below still
// search every entry in FAQ_ENTRIES regardless of topic), so adding a
// new topic here is safe and won't change what a typed question
// matches.
const FAQ_TOPICS = [
  { id: 'basics', title: 'New here? The basics' },
  { id: 'devikin-words', title: 'Devikin words explained' },
  { id: 'wallets', title: 'Wallets & wallet sets' },
  { id: 'browsing', title: 'Browsing & organizing your collection' },
  { id: 'troubleshooting', title: 'When something looks off' },
  { id: 'tools', title: 'Other tools' },
  { id: 'data-feedback', title: 'Data, feedback & about Devi' },
];

// The whole "brain" - a fixed list of question/answer pairs, each with a
// handful of keywords that, if typed, should surface that answer, plus
// the "topic" field used only for the grouped display above (see
// FAQ_TOPICS' own comment). This is intentionally small and specific to
// THIS app, not general knowledge - Devi doesn't know anything it isn't
// told here.
// "What does … mean?" for the game's own words, from the shared glossary
// (constants/glossary.js - the same text as the ⓘ on a detail page).
// Listed before the general traits answer, so "what is a procreation"
// lands here (on a tie the earlier entry wins).
const GLOSSARY_ENTRIES = Object.entries(GLOSSARY)
  .filter(([, term]) => term.question)
  .map(([key, term]) => ({
    id: `term-${key}`,
    topic: 'devikin-words',
    question: term.question,
    keywords: term.keywords,
    answer: term.more ? `${term.short} ${term.more}` : term.short,
  }));

const ALL_FAQ_ENTRIES = [
  {
    id: 'is-it-safe',
    topic: 'basics',
    question: 'Is the Hub safe? Can it move my NFTs or money?',
    keywords: ['safe', 'safety', 'secure', 'security', 'scam', 'steal', 'lose', 'money', 'risk', 'trust', 'private key', 'seed', 'password'],
    answer:
      "Yes, it's safe to look around: the Hub only ever reads public wallet addresses (the ones starting with klv1), which anyone can look up on the blockchain. It never asks for a password, private key or seed phrase - and you should never type those anywhere in the Hub. Nothing in the Hub can move, sell or send your NFTs or coins. Marking something as deleted, removing a wallet or even resetting all data only changes what the Hub shows - your real NFTs stay where they are.",
  },
  {
    id: 'what-is-nft',
    topic: 'basics',
    question: 'What is an NFT, and what is Klever?',
    keywords: ['nft', 'nfts', 'klever', 'blockchain', 'crypto', 'token', 'klv', 'chain', 'what is klever'],
    answer:
      "Devikins is a game whose creatures (Devikins), Weapons and Equipment are NFTs: one-of-a-kind digital items, each with its own ID number, recorded on a blockchain. That blockchain is Klever - a public record anyone can read, which is how the Hub can show what a wallet holds. A wallet address (starting with klv1) is like an account number: safe to share, so others can look up what it holds. KLV is Klever's coin.",
  },
  {
    // A stranger met the name "Moonlabs" with no explanation (fresh-eyes
    // review, 15 Oct 2026; Raphael asked for this answer 16 Oct).
    id: 'what-is-moonlabs',
    topic: 'basics',
    question: 'Who or what is Moonlabs?',
    keywords: ['moonlabs', 'moon labs', 'moonlab', 'company', 'developer', 'developers', 'studio', 'who made', 'makers'],
    answer:
      "Moonlabs is the company that makes and runs Devikins - the game itself, its servers, and the details and pictures of every Devikin, Weapon and Equipment. The Hub reads those details and pictures from Moonlabs' server. When that server doesn't answer or sends something incomplete, you see blank pictures or missing details (\"Hide blanks\" keeps those out of view), and the Hub tries again by itself later. The Hub is a fan-made project, not affiliated with or endorsed by Moonlabs or Klever.",
  },
  ...GLOSSARY_ENTRIES,
  {
    id: 'rarity',
    topic: 'basics',
    question: 'What do Rarity, Ancestry and the other traits mean?',
    keywords: ['rarity', 'rare', 'rarest', 'common', 'uncommon', 'mythic', 'eldritch', 'best', 'valuable', 'ancestry', 'trait', 'traits'],
    answer:
      "Every NFT has traits set by the game. Rarity, from lowest to highest: Common, Uncommon, Rare, Mythic, Eldritch. Ancestry is a Devikin's family: Glysian, Khoroth, Lunarian, Maarish or Ochran. Life Stage is how far it has grown, and Procreations Left is how many more times it can breed. Weapons and Equipment also have a Quality. To find the rarest ones, tap the sort button (left of the search box, it shows \"↑ ID\" at first), pick Rarity and tap ↓ for highest first - or use Filters to show only one rarity. A \"—\" means the game hasn't given that NFT a value for that trait.",
  },
  {
    id: 'add-wallet',
    topic: 'wallets',
    question: 'How do I add a wallet?',
    keywords: ['wallet', 'address', 'klv1', 'wallets', 'connect'],
    answer:
      "Open the ☰ menu and tap Set Up > Wallets. Paste your Klever wallet address (starts with klv1...) and tap Add. You can add as many wallets as you like, and give each one a nickname from its Edit button.",
  },
  {
    id: 'wallet-sets',
    topic: 'wallets',
    question: 'How do wallet sets work?',
    keywords: ['set', 'sets', 'wallet set', 'wallet sets', 'switch', 'profile', 'profiles', 'friend', 'kid'],
    answer:
      "Further down the Wallets screen, below your wallets, is the Wallet sets section - completely separate, independently saved collections of wallets and their fetched NFTs. Handy if two people share the app (each gets their own set), or if you want to peek at a friend's collection without mixing it into your own. Tap + New set to start one; tap any set's name to load it. Rename any set any time. Delete removes a set for good, including its downloaded images.",
  },
  {
    id: 'export-import-sets',
    platform: 'app',
    topic: 'wallets',
    question: 'How do I back up or transfer a wallet set?',
    keywords: ['export', 'import', 'backup', 'back up', 'transfer', 'move', 'zip', 'restore', 'save file'],
    answer:
      "Each wallet set has its own Export button (next to its name on the Wallets screen), which saves everything in that set - wallets, fetched NFTs, and every downloaded image - into a single zip file you can share or save wherever you like. \"Export all sets\" does the same for every set at once. Import (also on the Wallets screen) reads one of those zip files back in as a new set. Every file it writes is checked against the zip's own checksum afterward, so you'll be warned if anything didn't come through intact. While an export or import is running, everything else on the Wallets screen - switching sets, adding or editing wallets, Delete, Reset All Data, even leaving the screen - is locked until it finishes, since those all touch the same files the export or import is actively working with.",
  },
  {
    id: 'fetch-update',
    topic: 'wallets',
    question: 'What does Fetch/Update do?',
    keywords: ['fetch', 'update', 'scan', 'refresh', 'sync'],
    answer:
      "It asks the Klever blockchain which Devikins, Weapons, and Equipment your wallet(s) hold, then downloads each one's details and picture. The first fetch takes the longest since nothing's cached yet - after that, it's much faster. It never looks for new NFTs on its own - that only happens when you tap Fetch/Update. While the Hub is open, though, it quietly retries items that failed (and missing pictures) by itself, so most stragglers fix themselves; if something stays stuck, tap Fetch/Update again.",
  },
  {
    id: 'scan-notification',
    platform: 'app',
    topic: 'wallets',
    question: "Why does a notification appear while I'm fetching?",
    keywords: ['notification', 'background', 'scan running', 'foreground service', 'switch apps', 'lock screen', 'swipe', 'close app', 'closed', 'walk away', 'leave app', 'background scan'],
    answer:
      "That's what lets a Fetch/Update keep going even if you switch to another app, lock your phone, or close the app entirely by swiping it away from Recents - confirmed on a real device, a big fetch keeps right on running and the notification keeps updating with live progress, so you're free to walk away or browse elsewhere instead of having to sit and watch it finish. It clears itself automatically the moment the fetch finishes, is cancelled, or hits an error - it isn't something you need to tap or dismiss yourself. One thing that never changes: only a fetch you actually started keeps going this way - the app never wakes itself up or starts a fetch on its own, closed or not. If you decline the notification permission, Fetch/Update still works exactly the same, it just won't be protected if you leave the app for a long stretch.",
  },
  {
    id: 'deleted',
    topic: 'browsing',
    question: "What does marking something 'Deleted' do?",
    keywords: ['delete', 'deleted', 'hide', 'sold', 'restore', 'remove', 'traded'],
    answer:
      "It's a personal organizing flag only - nothing is removed from the blockchain, or even from this app's own database. It greys the item out (or hides it entirely with \"Hide deleted\" - the 🗑️ button above the list; a small line under the count at the top then says \"deleted hidden\") so your list stays tidy, and you can tap Restore on it any time. One thing to know: if you still hold the NFT, the next Fetch/Update will automatically un-delete it, since successfully re-fetching it is proof you still own it.",
  },
  {
    id: 'list-tiles',
    topic: 'browsing',
    question: "What's the difference between List and Tiles view?",
    keywords: ['list', 'tiles', 'grid', 'view', 'layout'],
    answer:
      "The ▤ | ▦ switch above the list picks the view: List (▤) shows a picture plus a few key stats for each item; Tiles (▦) shows a compact grid of just the pictures, so you can scan a big collection faster. Each of Devikins/Weapons/Equipment remembers its own choice.",
  },
  {
    id: 'search-star-filter',
    topic: 'browsing',
    question: 'How do search and the star filter work?',
    keywords: ['search', 'star filter', 'filter'],
    answer:
      "The search bar at the top matches an NFT's name, your own custom nickname for it, or its ID, and narrows the list as you type. The star Rating filter lives in Filters (tap Filters) - tap a star and every star up to it lights up, and the list narrows straight away to items rated EXACTLY that many stars (not 'that many or more'); tap the same star again (or Clear) to undo it. Both search and an already-applied star rating carry over as you switch between Devikins/Weapons/Equipment.",
  },
  {
    id: 'sort-vs-filters',
    topic: 'browsing',
    question: "What's the difference between Sort and Filters?",
    keywords: ['sort', 'sorting', 'sort vs filter', 'sort and filter', 'order', 'difference'],
    answer:
      "Sort picks one thing to order the whole list by - tap the sort button (e.g. ID or Rarity) and pick a field, and it applies the moment you tap it, no Apply needed. It never removes anything, just changes the order everything shows up in. Filters work straight away too: each pick narrows the list at once (typed min/max numbers after a short pause), and the button under the toolbar shows how many are left, e.g. 'Show 12 Devikins' - tap it to close the panel and see them. Closing Filters keeps your picks; 'Filters ✕' removes them all. Filters also remembers what you last picked, so reopening it lets you add, change, or remove any of your picks - narrowing further, loosening up, or swapping one for another - without starting over. Search, Sort, and Filters all work together at once - with a big collection, combining them (say, filter to one Rarity, sort those by Ancestry, then search by name) is usually the fastest way to find one specific NFT.",
  },
  {
    id: 'devikin-filter-groups',
    topic: 'browsing',
    question: 'Why can\'t I see all the Devikins filters at once?',
    keywords: ['genes', 'affinities', 'attributes', 'devikin filters', 'more filters', 'filter groups', 'grouped filters'],
    answer:
      "Devikins have 21 filterable traits, so on that tab Filters groups them to stay scannable: Rating, Rarity, Ancestry, Personality, Life Stage, and Procreations Left are always visible, and the rest sit inside three tappable sections - Genes, Affinities, and Attributes - each closed until you tap its name to open it. Picking a filter inside a closed section still works fine even if you leave it closed afterward; you just need to open a section once to reach the filters inside it. Weapons and Equipment aren't grouped this way yet - their filters are still one plain list.",
  },
  {
    id: 'name-rating',
    topic: 'browsing',
    question: 'How do I give an NFT a nickname or rating?',
    keywords: ['nickname', 'rate', 'rating', 'name this', 'rename', 'stars', 'unrate', 'un-rate', 'remove rating', 'clear rating'],
    answer:
      "Open its detail view - right above the Notes section you'll find a Name field with a Save Name button, and a row of 5 stars. Type a name and tap Save Name to save it. Tap a star to rate it - once you have, a Clear Rating button appears right below the stars to un-rate it again (tapping the same star a second time does the same thing).",
  },
  {
    id: 'changelog',
    topic: 'browsing',
    question: "What's the Changelog button in an item's detail view?",
    keywords: ['changelog', 'history', 'nft history', 'change log', 'past values', 'what changed', 'track changes'],
    answer:
      "Open any item's detail view and, if the app has ever caught a real change on it, a floating Changelog button appears bottom-right. Tap it for a simple list of every change, newest first, grouped by when it was caught. This only tracks actual trait changes seen during a fetch (old value → new value) - not everything about the item, and not a change to something it never had a value for before. Weapon Durability is deliberately left out, since it shifts constantly during normal play and isn't meaningful history. An item with no logged changes yet just won't show the button at all.",
  },
  {
    id: 'kleverscan',
    topic: 'tools',
    platform: 'app',
    question: 'What is the Kleverscan tab?',
    keywords: ['kleverscan', 'explorer', 'holders', 'block explorer', 'holder', 'browser'],
    answer:
      "Open the ☰ menu and tap Set Up > Kleverscan for a small built-in browser pointed straight at the Devikins collection's Holders list on kleverscan.org, Klever's own block explorer - no typing in a search box needed. Handy for checking who's holding what, and it's also a good way to find your own wallet address if you don't have it handy: if you know roughly how many Devikins you hold, you can browse the holder list and spot yourself.",
  },
  {
    id: 'kleverscan-web',
    topic: 'tools',
    platform: 'web',
    question: 'What is the Kleverscan tab?',
    keywords: ['kleverscan', 'explorer', 'holders', 'block explorer', 'holder', 'browser'],
    answer:
      "Open the ☰ menu and choose Kleverscan to open, in a new browser tab, the Devikins collection's Holders list on kleverscan.org, Klever's own block explorer - no typing in a search box needed. Handy for checking who's holding what, and it's also a good way to find your own wallet address if you don't have it handy: if you know roughly how many Devikins you hold, you can browse the holder list and spot yourself.",
  },
  {
    id: 'klv-signer',
    platform: 'app',
    topic: 'tools',
    question: 'What is KLV Signer (test)?',
    keywords: ['signer', 'klv signer', 'send', 'transfer', 'sign', 'signature', 'testnet', 'private key', 'transaction'],
    answer:
      "Open the ☰ menu and tap Features > KLV Signer (test) to send KLV, tokens or NFTs on Klever's testnet - the practice network, where nothing has real value. It needs the separate KLV Signer app on your phone: Devikins Legacy Hub never holds your wallet's private key. Tap Connect KLV Signer once (the Signer asks whether to allow the Hub), then enter a receiver and an amount and tap Send with KLV Signer. The Signer shows you exactly what will be sent and only signs after you enter your Signer password; the Hub then sends it to the testnet and gives you a Kleverscan link. Before every request the Hub checks with Android that the Signer on your phone is the official one (by its seal, the signing certificate); a fake app pretending to be the Signer gets nothing. It's testnet-only for now because the Signer is still being tested - sending your real Devikins will come later.",
  },
  {
    id: 'breeding-helper',
    topic: 'tools',
    question: 'What does Breeding Helper do?',
    keywords: ['breeding', 'breed', 'breeding helper', 'procreation', 'procreate', 'partner', 'pairing'],
    answer:
      "Open the ☰ menu and tap Features > Breeding Helper for a two-step finder for breeding partners among your own Devikins. Step 1 narrows your collection by Rarity, Ancestry, Procreations Left, and optionally up to two Target Affinities - tap a result to pick it as your starting Devikin. Step 2 then lists every other Devikin that's actually a match: same Rarity always, and by default the same Procreations Left too (turn on \"Allow +/-1\" if you need a bit more room there), ranked by how well they match your chosen Affinities, with an estimated breeding cost and the offspring's resulting Procreations Left. One thing it can't do: tell you whether two Devikins are actually related - there's no parent/lineage data anywhere in the game's own data, so that check is still on you, same as in the game itself.",
  },
  {
    id: 'compare-mode',
    topic: 'tools',
    question: 'How does Compare mode work?',
    keywords: ['compare', 'compare mode', 'side by side', 'compare two'],
    answer:
      "Tap the ⇄ Compare button next to the ▤ | ▦ (List / Tiles) switch on any collection tab. While it's on, tapping an item selects it (up to two, highlighted with a colored border) instead of opening its detail view - pick a second item of the same kind and it opens straight into a full side-by-side listing of every one of its stats. \"Show differences only\" hides anything the two agree on, handy when you're just deciding which one to keep. It compares whatever you've already got filtered/sorted/searched in that list - tap ‹ to go back and pick two different items.",
  },
  {
    id: 'feedback',
    topic: 'data-feedback',
    question: 'How do I send feedback or report a bug?',
    keywords: ['feedback', 'bug', 'report', 'suggest', 'contact', 'email', 'request'],
    answer:
      "Open the ☰ menu and tap Help > Feedback. Pick a category, write your message, and tap Open Email Draft - it opens your own email app with everything already filled in. You just need to hit Send yourself.",
  },
  {
    id: 'unavailable-failed',
    topic: 'troubleshooting',
    question: "Why does an item say 'Unavailable' or 'Fetch failed'?",
    keywords: ['unavailable', 'missing', 'failed', 'no image', 'no data', 'no picture', 'picture missing'],
    answer:
      "'Unavailable' in the picture spot means only the picture is missing: Moonlabs' picture server doesn't have it, or sent a broken one. The NFT itself exists and its details are there. The Hub tries the picture again by itself later, and \"Hide blanks\" (the 🖼️ button above the list) can hide these meanwhile. 'Fetch failed' means the details didn't come through this time, usually because Moonlabs' server timed out - those are retried automatically while the Hub is open (about once a minute at first, then less often) and whenever you tap Fetch/Update. Rarely an NFT shows 'Details unavailable': Moonlabs' server said it has no details for it at all, which is treated as final.",
  },
  {
    id: 'reset-data',
    topic: 'data-feedback',
    question: 'How do I reset all my data?',
    keywords: ['reset', 'wipe', 'start over', 'fresh install'],
    answer:
      "For everything: open Wallets from the ☰ menu, scroll down to Danger zone, flip its toggle on to reveal Reset All Data, and tap it - this wipes every wallet set, every saved wallet, every stored NFT, and every downloaded image, back to exactly a fresh install. It can't be undone, though your real NFTs on the blockchain are never touched. For just one set gone wrong, its own Delete button (next to it under Wallet sets, further up the same screen) is the gentler option - it only erases that one set, leaving the rest of your sets untouched.",
  },
  {
    id: 'automatic-retry',
    topic: 'troubleshooting',
    question: 'Does the app retry failed items automatically?',
    keywords: ['automatic', 'automatically', 'background retry', 'auto retry', 'retry'],
    answer:
      "Yes, while the app is open - it quietly checks for anything left over ('Fetch failed' items, or items missing a cached image) and retries just those, on its own, without you needing to tap Fetch/Update. It checks right when you open the app and whenever you come back to it, then keeps checking about once a minute for a while, backing off to about once an hour once everything's caught up. It won't run in the background once the app is fully closed, and it never fetches anything genuinely new on its own - only cleaning up items that already failed.",
  },
  {
    id: 'theme-toggle',
    topic: 'tools',
    question: "Where's the light/dark mode button?",
    keywords: ['theme', 'dark mode', 'light mode', 'dark', 'light', 'appearance'],
    answer:
      "Top right of the screen, on the same row as the ☰ menu button - ☀️ | 🌙 side by side, with the mode you're in highlighted. Tap the other one to switch.",
  },
  {
    id: 'multiple-wallets',
    topic: 'wallets',
    question: 'Can I add more than one wallet?',
    keywords: ['multiple wallets', 'second wallet', 'another wallet', 'two wallets', 'many wallets'],
    answer:
      "Yes - open Wallets from the ☰ menu and add as many addresses as you like. Fetch/Update pulls Devikins, Weapons, and Equipment from all of them together, as long as they're in the same wallet set - a different set has its own separate wallets. You can give each wallet its own nickname from its Edit button.",
  },
  {
    id: 'export-import-sets-web',
    topic: 'wallets',
    platform: 'web',
    question: 'How do I back up or transfer a wallet set?',
    keywords: ['export', 'import', 'backup', 'back up', 'transfer', 'move', 'zip', 'restore', 'save file', 'download'],
    answer:
      "On the Wallets screen, each wallet set has its own Export button, and \"Export all sets\" saves every set at once. The backup downloads as a zip file (usually into your Downloads folder) with your wallets, fetched NFTs, names, stars, comments and pictures. \"Import Set(s)\" reads such a file back in (one set or all of them). After an export on the website, the Hub confirms where the file went. Backups work both ways between the website and the Android app. Every file is checked against the backup's own checksum, so you'll be warned if anything didn't come through intact.",
  },
  {
    id: 'website-storage',
    topic: 'data-feedback',
    platform: 'web',
    question: 'Where does the website keep my data?',
    keywords: ['data', 'storage', 'stored', 'saved', 'browser', 'website', 'safari', 'lost', 'gone', 'privacy', 'server', 'another device', 'other browser'],
    answer:
      "Only in this browser on this device - nothing is uploaded anywhere. That also means it's separate per browser and device: Chrome and Safari, or your computer and your phone, each have their own copy. When you add a wallet, the Hub asks the browser to keep this data permanently (Firefox may show a small question about it - saying yes helps). Clearing this site's data (or using a private window) removes it, and Safari may delete it by itself if you don't visit the site for about 7 days (unless it's added to your Home Screen). So export a backup now and then (Wallets → Export all sets) - it takes a few seconds and can be imported again anywhere.",
  },
  {
    id: 'connect-extension',
    topic: 'wallets',
    platform: 'web',
    question: 'What does "Connect Klever Extension" do?',
    keywords: ['connect', 'extension', 'klever extension', 'browser extension', 'klever wallet', 'link wallet'],
    answer:
      "If you use the Klever Wallet browser extension, this button (on the Wallets screen, under the address field) reads the address of the wallet that's open in the extension and adds it to your list - no copying and pasting. Only the public address is read; the Hub never sees any keys.",
  },
  {
    id: 'withdrawals',
    topic: 'tools',
    question: 'How do I check whether my withdrawals from the game arrived?',
    keywords: ['withdraw', 'withdrawal', 'withdrawals', 'arrived', 'arrive', 'transfer', 'in-game wallet', 'custody', 'missing', 'overdue', 'support ticket', 'tracker'],
    answer:
      "Open Withdrawals in the ☰ menu. Enter your in-game wallet (where the game sends from) and your own wallet (where it should arrive), then paste the IDs of the NFTs you want to follow - with headings like \"Weapons\" one paste can hold all kinds. Switch on \"Requested in game\" when you paste them, or later select them under Results and tap Mark requested. Check asks the Klever blockchain where every NFT that hasn't arrived yet is: Arrived, still in your in-game wallet, still in the game's main wallet, or somewhere else. Anything requested that hasn't arrived after 30 minutes (you can change that) shows as Overdue, and you can copy that list for a support ticket. To look up specific NFTs, tick them under Results and tap Check selected. While the Withdrawals screen is open, the NFTs you've requested are also checked by themselves every 5 minutes, so they turn to Arrived without you pressing Check. The arrivals log shows everything that came into your wallet, with date and sender.",
  },
  {
    id: 'getting-started',
    topic: 'wallets',
    question: 'How do I get started?',
    keywords: ['start', 'started', 'getting started', 'begin', 'first', 'how to use', 'setup', 'set up', 'guide', 'checklist', 'order', 'steps'],
    answer:
      "The Hub walks you through it: 1. Open Wallets (the Hub opens there by itself the first time) and paste a wallet address - only the public address starting with klv1, never a key. 2. Say what it is: \"In-game wallet\" (where the game keeps your NFTs), \"My wallet\" (your own), \"Someone else's wallet\" (just looking - it gets a set of its own) or a name of your choice. If they're yours, the Hub asks whether to mark the set as \"My wallets\". 3. Tap Fetch now to load the Devikins, Weapons and Equipment those wallets hold. 4. Optional: on the Withdrawals screen, add the IDs of NFTs you own that are still in the game - they then show in your collection too. 5. Save a backup (Wallets > Export all sets). After each fetch the Hub asks the next question by itself, ending with a reminder to save a backup. ☰ > Set Up > Getting started shows a checklist of what's done.",
  },
  {
    id: 'my-wallets',
    topic: 'wallets',
    question: 'How do I see my NFTs that are still in the game?',
    keywords: ['my wallets', 'own', 'game wallet', 'main wallet', 'custody', 'id list', 'ids', 'not in my wallet', 'still in the game', 'missing nfts', 'withdrawals list'],
    answer:
      "Most game NFTs sit in the game's main wallet, not in yours, so a normal Fetch/Update can't find them. Paste their IDs into the Withdrawals screen's list, then on the Wallets screen switch on \"My wallets\" for your own set (only one set can be yours). From the next Fetch/Update on, that set also shows the IDs on your Withdrawals list, wherever those NFTs are - each one's details say where it sits. Sets for other people's wallets keep the switch off, so they only show what those wallets hold. Moonlabs' server doesn't deliver every NFT; \"Hide blanks\" keeps incomplete ones out of view until they come through.",
  },
  {
    id: 'hide-blanks',
    topic: 'browsing',
    question: 'What does "Hide blanks" do?',
    keywords: ['blank', 'blanks', 'hide blanks', 'empty', 'white', 'missing picture', 'no picture', 'background', 'unavailable', 'incomplete'],
    answer:
      "Some NFTs come back from Moonlabs' servers incomplete: no details, no picture, or a picture that's plain white or only shows the coloured background without the item. With \"Hide blanks\" on (the 🖼️ button above the list, next to 🗑️ for deleted ones), those are left out and a small line under the count at the top says \"blanks hidden\" so you only see complete NFTs. Nothing is deleted - the Hub keeps retrying them quietly, and they appear by themselves once Moonlabs delivers them properly. Pictures you already have are checked once in the background. The button remembers its setting (hover over it, or hold it on the phone, to see what it does). Devikins whose picture shows a body without a face still count as complete.",
  },
  {
    id: 'donate',
    topic: 'data-feedback',
    question: 'How can I support the Hub?',
    keywords: ['donate', 'donation', 'support', 'tip', 'pay', 'free', 'cost', 'price'],
    answer:
      "The Hub is free and stays free. If you'd like to support it, open Donate in the ☰ menu: you can copy the donation address and send any amount of KLV from your own wallet. On the website you can also donate directly through the Klever browser extension - it shows the transfer for you to approve, and nothing is sent unless you confirm it there. Klever adds a network fee of about 3 KLV per transfer.",
  },
  {
    id: 'about-counter',
    topic: 'data-feedback',
    question: 'What does the About screen show, and what is counted?',
    keywords: ['about', 'version', 'counter', 'users', 'statistics', 'tracking', 'count me', 'anonymous', 'privacy', 'opt out'],
    answer:
      "About (in the ☰ menu) shows the Hub's version, how many people use it and how often it's opened. Only people who actually use the Hub are counted: once you've added a wallet (or imported a backup), the Hub sends a random ID - not linked to you, your wallets or your device - each time it's opened, together with \"website\" or \"app\" and the version. Nothing else is sent. You can switch it off with \"Count me (anonymously)\" on the About screen.",
  },
  {
    id: 'who-are-you',
    topic: 'data-feedback',
    question: 'Who or what are you?',
    keywords: ['who are you', 'what are you', 'are you ai', 'are you claude', 'real ai', 'robot'],
    answer:
      "I'm Devi - a tiny, offline helper built into this app. I'm not a real AI: I can't think, I don't learn, and I only know the handful of canned answers listed here about using this app.",
  },
];

// Some answers only apply to the phone app ('app') or only to the website
// ('web') - e.g. the scan notification and the KLV Signer exist only in
// the Android app, while the browser storage answer only matters on the
// website. Entries without a platform apply to both.
const FAQ_ENTRIES = ALL_FAQ_ENTRIES.filter(
  (entry) => !entry.platform || entry.platform === (Platform.OS === 'web' ? 'web' : 'app')
);

const GREETING =
  "Hi, I'm Devi! I'm a small offline helper, not a real AI - I only know a fixed set of answers about using this app. Try one of the questions below, or type your own.";

const FALLBACK_ANSWER =
  "I don't have an answer for that one - I'm just a lightweight offline helper with a fixed list of canned answers, not a real AI. Try one of the suggested questions below, or use Feedback from the ☰ menu to ask Raphael, who makes the Hub.";

// Lowercases and strips punctuation down to plain words separated by
// single spaces - "What's Fetch/Update do??" becomes "what s fetch
// update do", so matching below doesn't trip over apostrophes, slashes,
// or extra punctuation the way a plain substring check would.
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain Levenshtein edit distance (how many single-character insertions/
// deletions/substitutions turn one word into the other) - a small,
// dependency-free way to tolerate typos like "walet" for "wallet"
// without needing any real spell-checking library. Fine for this app's
// tiny, fixed vocabulary; would be far too slow/crude for anything
// bigger.
function editDistance(a, b) {
  const table = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    table.push([i, ...Array(b.length).fill(0)]);
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i][j] = Math.min(
        table[i - 1][j] + 1, // deletion
        table[i][j - 1] + 1, // insertion
        table[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return table[a.length][b.length];
}

// How many typo'd characters to tolerate for a keyword of this length -
// short words need a close match (one wrong letter in a 3-4 letter word
// often changes its meaning entirely), longer ones can afford a bit more
// slack.
function maxTypoDistance(keywordLength) {
  if (keywordLength <= 4) return 0;
  if (keywordLength <= 7) return 1;
  return 2;
}

// Does one typed word count as matching a single-word keyword - exact,
// a plain prefix either direction ("wallet" typed for keyword "wallets"
// or vice versa), or close enough to count as a typo?
// Little everyday words never count as a match on their own - "the" used
// to match "theme" and "his" matched "history", so "which one is the
// rarest?" got the light/dark answer (fresh-eyes review, 15 Oct 2026).
const IGNORED_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'be', 'it', 'its', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'my',
  'your', 'our', 'i', 'me', 'you', 'we', 'he', 'she', 'they', 'what', 'which', 'who', 'how', 'why', 'when', 'where',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or',
  'with', 'from', 'by', 'about', 'one', 'some', 'any', 'all', 'there', 'here', 'so', 'if', 'not', 'no', 'yes',
]);

function wordMatchesKeyword(word, keyword) {
  if (word === keyword) return true;
  if (IGNORED_WORDS.has(word)) return false;
  // A shortened or longer form ("wallet" / "wallets", "fetch" /
  // "fetching") - but not a short word that merely starts a much longer
  // keyword ("klever" is not "kleverscan").
  if (word.length >= 4 && keyword.startsWith(word) && keyword.length - word.length <= 3) return true;
  if (keyword.length >= 4 && word.startsWith(keyword) && word.length - keyword.length <= 4) return true;
  return editDistance(word, keyword) <= maxTypoDistance(keyword.length);
}

// Scores one FAQ entry against the typed text. A multi-word keyword
// (e.g. "star filter", "fresh install") still needs to appear as a
// substring, same as the original plain matching; a single-word keyword
// (most of them) now also counts if any typed word is a close typo or
// prefix of it, not just an exact substring - that's what lets "walet"
// or "wallting" still find the wallet answer.
function scoreEntry(entry, normalizedInput, inputWords) {
  let score = 0;
  for (const keyword of entry.keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (normalizedKeyword.includes(' ')) {
      if (normalizedInput.includes(normalizedKeyword)) score += 1;
    } else if (inputWords.some((word) => wordMatchesKeyword(word, normalizedKeyword))) {
      score += 1;
    }
  }
  return score;
}

// Finds whichever FAQ entry scores highest against the typed text (see
// scoreEntry above) - still just keyword matching, not a real language
// model, but forgiving of small typos and a bit of phrasing variation
// rather than needing an exact keyword substring. No match at all
// (score 0 everywhere) returns null, which is when FALLBACK_ANSWER is
// used.
function matchEntry(inputText) {
  const normalizedInput = normalizeText(inputText);
  const inputWords = normalizedInput.split(' ').filter(Boolean);
  let bestEntry = null;
  let bestScore = 0;

  for (const entry of FAQ_ENTRIES) {
    const score = scoreEntry(entry, normalizedInput, inputWords);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestEntry;
}

let nextMessageId = 1;
function makeMessage(sender, text) {
  nextMessageId += 1;
  return { id: nextMessageId, sender, text };
}

export default function HelpAssistant({ onClose }) {
  const { colors } = useTheme();
  const [messages, setMessages] = useState(() => [makeMessage('assistant', GREETING)]);
  const [inputText, setInputText] = useState('');
  const scrollViewRef = useRef(null);
  // The chat bubbles and the always-visible FAQ list below them share
  // one long ScrollView (see the JSX comment further down). Sending a
  // question used to call scrollToEnd(), which jumps to the very
  // bottom of that whole ScrollView - i.e. past your new answer bubble
  // and all the way down to the end of the FAQ list - so the answer
  // that just appeared was scrolled straight out of view and it looked
  // like nothing had happened. Instead we measure the chat bubbles'
  // own height (messagesBlockRef's onLayout below) and the visible
  // viewport height (this ref, from the ScrollView's own onLayout),
  // and scroll only far enough to bring the newest bubble to the
  // bottom of the visible area, the way a normal chat screen does.
  const viewportHeightRef = useRef(0);

  function respondTo(questionText) {
    const trimmed = questionText.trim();
    if (!trimmed) return;

    const matchedEntry = matchEntry(trimmed);
    const answerText = matchedEntry ? matchedEntry.answer : FALLBACK_ANSWER;

    setMessages((previous) => [
      ...previous,
      makeMessage('user', trimmed),
      makeMessage('assistant', answerText),
    ]);
  }

  function handleSend() {
    respondTo(inputText);
    setInputText('');
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: colors.primary }]}
        onPress={onClose}
      >
        <Text style={[styles.backButtonText, { color: colors.primaryText }]}>‹</Text>
      </TouchableOpacity>

      <Text style={[styles.title, { color: colors.text }]}>Devi</Text>
      <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
        An offline in-app helper - not a real AI, just a fixed list of answers about using this app.
      </Text>

      <KeyboardAvoidingView
        style={styles.flexOne}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.chatLog}
          contentContainerStyle={styles.chatLogContent}
          onLayout={(event) => {
            viewportHeightRef.current = event.nativeEvent.layout.height;
          }}
        >
          <View
            onLayout={(event) => {
              // Fires whenever the chat bubbles' own total height
              // changes - i.e. whenever a message is added - with the
              // FAQ list below excluded, since it's a sibling, not part
              // of this measured View. Skip the very first render
              // (just the greeting) so opening the screen doesn't
              // scroll anywhere on its own.
              if (messages.length <= 1) return;
              const messagesHeight = event.nativeEvent.layout.height;
              const targetY = Math.max(0, messagesHeight - viewportHeightRef.current + 24);
              scrollViewRef.current?.scrollTo({ y: targetY, animated: true });
            }}
          >
            {messages.map((message) => {
            const isUser = message.sender === 'user';
            return (
              <View
                key={message.id}
                style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}
              >
                <View
                  style={[
                    styles.bubble,
                    { backgroundColor: isUser ? colors.primary : colors.surfaceAlt, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.bubbleText, { color: isUser ? colors.primaryText : colors.text }]}>
                    {message.text}
                  </Text>
                </View>
              </View>
            );
          })}
          </View>

          {/* The full FAQ, always visible - every question with its
              answer listed directly underneath it, one after another,
              rather than behind tappable chips you'd have to try one at
              a time to see what's there. Typing your own question below
              still works and appends its own answer as a chat bubble
              above this list. Grouped under FAQ_TOPICS' headings rather
              than one flat 17-entry list (see FAQ_TOPICS' own comment
              above) - a topic with no entries just renders nothing,
              rather than an empty heading, so adding a topic ahead of
              having anything filed under it yet is harmless. */}
          <View style={[styles.faqSection, { borderTopColor: colors.border }]}>
            <Text style={[styles.faqSectionTitle, { color: colors.secondaryText }]}>
              Frequently asked
            </Text>
            {FAQ_TOPICS.map((topic) => {
              const entries = FAQ_ENTRIES.filter((entry) => entry.topic === topic.id);
              if (entries.length === 0) return null;
              return (
                <View key={topic.id} style={styles.faqTopicGroup}>
                  <Text style={[styles.faqTopicTitle, { color: colors.secondaryText }]}>
                    {topic.title}
                  </Text>
                  {entries.map((entry) => (
                    <View key={entry.id} style={styles.faqEntry}>
                      <Text style={[styles.faqQuestion, { color: colors.primary }]}>{entry.question}</Text>
                      <Text style={[styles.faqAnswer, { color: colors.text }]}>{entry.answer}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.textInput, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, color: colors.text }]}
            placeholder="Ask Devi something..."
            placeholderTextColor={colors.secondaryText}
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleSend}
            returnKeyType="send"
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              { backgroundColor: colors.primary },
              inputText.trim().length === 0 && { backgroundColor: colors.primaryDisabled },
            ]}
            onPress={handleSend}
            disabled={inputText.trim().length === 0}
          >
            <Text style={[styles.sendButtonText, { color: colors.primaryText }]}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flexOne: {
    flex: 1,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginHorizontal: 12,
    marginVertical: 12,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginHorizontal: 12,
  },
  subtitle: {
    fontSize: 13,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 12,
  },
  chatLog: {
    flex: 1,
  },
  chatLogContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 10,
  },
  bubbleRow: {
    flexDirection: 'row',
  },
  bubbleRowUser: {
    justifyContent: 'flex-end',
  },
  bubbleRowAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '82%',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  // The always-visible FAQ list - see the JSX comment above. Sits
  // inside the same scrollable area as the chat bubbles, set off by its
  // own top border and a small muted section title.
  faqSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  faqSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  // One per FAQ_TOPICS entry - just spacing between topic groups, no
  // border/background of its own (faqSection above already draws the
  // one border that sets the whole FAQ apart from the chat bubbles).
  faqTopicGroup: {
    marginBottom: 20,
  },
  // Sits between faqSectionTitle ("Frequently asked", the whole FAQ's
  // own label) and each entry's own faqQuestion below - a second,
  // smaller level of heading, same muted color as faqSectionTitle but
  // not uppercase/letter-spaced, so it reads as one level down rather
  // than a repeat of the section title.
  faqTopicTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
  },
  faqEntry: {
    marginBottom: 16,
  },
  faqQuestion: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  faqAnswer: {
    fontSize: 13,
    lineHeight: 19,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonText: {
    fontWeight: '600',
  },
});
