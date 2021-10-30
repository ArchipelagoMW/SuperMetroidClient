// Client version data
const CLIENT_VERSION = {
  state: 'Beta',
  major: 0,
  minor: 11,
  patch: 0,
};

const ARCHIPELAGO_PROTOCOL_VERSION = {
  major: 0,
  minor: 1,
  build: 9,
  class: 'Version',
};

// Archipelago server
const DEFAULT_SERVER_PORT = 38281;
let serverSocket = null;
let lastServerAddress = null;
let serverPassword = null;
let serverAuthError = false;

const permissionMap = {
  0: 'Disabled',
  1: 'Enabled',
  2: 'Goal',
  6: 'Auto',
  7: 'Enabled + Auto',
};

// Players in the current game, received from Connected server packet
let playerSlot = null;
let playerTeam = null;
let players = [];
let hintCost = null;

// Object mapping AP itemIds to their names
const apItemsById = {};

// Object mapping AP locationIds to their names
const apLocationsById = {};

// Data shared between main and renderer processes
let sharedData = {};

// The user has the option to pause receiving items
let receiveItems = true;
