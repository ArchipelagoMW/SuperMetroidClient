// noinspection JSBitwiseOperatorUsage

let itemsReceived = [];
const maxReconnectAttempts = 10;
let reconnectAttempts = 0;

// Control variable for the SNES watcher. Contains an interval (see MDN: setInterval)
let snesInterval = null;
let snesIntervalComplete = true;
let lastBounce = 0;

// Location Ids provided by the server
let checkedLocations = [];
let missingLocations = [];

// Data about remote items
const scoutedLocations = {};

let gameCompleted = false;
const CLIENT_STATUS = {
  CLIENT_UNKNOWN: 0,
  CLIENT_READY: 10,
  CLIENT_PLAYING: 20,
  CLIENT_GOAL: 30,
};

window.addEventListener('load', () => {
  // Handle server address change
  document.getElementById('server-address').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') { return; }

    // If the input value is empty, do not attempt to reconnect
    if (!event.target.value) {
      if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
        lastServerAddress = null;
        serverSocket.close();
        serverSocket = null;
      }
    }

    connectToServer(event.target.value);
  });
});

const connectToServer = (address, password = null) => {
  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
    serverSocket.close();
    serverSocket = null;
  }

  // This is a new connection attempt, no auth error has occurred yet
  serverAuthError = false;

  // If there are no SNES devices available, do nothing
  if (snesDevice === null) { return; }

  // Determine the server address
  let serverAddress = address;
  if (serverAddress.search(/^\/connect /) > -1) { serverAddress = serverAddress.substring(9); }
  if (serverAddress.search(/:\d+$/) === -1) { serverAddress = `${serverAddress}:${DEFAULT_SERVER_PORT}`;}

  // Store the password, if given
  serverPassword = password;

  // Attempt to connect to the server
  serverSocket = new WebSocket(`ws://${serverAddress}`);
  serverSocket.onopen = (event) => {
    // If a new server connection is established, that server will inform the client which items have been sent to
    // the ROM so far, if any. Clear the client's current list of received items to prevent the old list from
    // contaminating the new one, sometimes called "seed bleed".
    itemsReceived = [];
  };

  // Handle incoming messages
  serverSocket.onmessage = async (event) => {
    const commands = JSON.parse(event.data);
    for (let command of commands) {
      const serverStatus = document.getElementById('server-status');
      switch(command.cmd) {
        case 'RoomInfo':
          // Update sidebar with info from the server
          document.getElementById('server-version').innerText =
            `${command.version.major}.${command.version.minor}.${command.version.build}`;
          document.getElementById('forfeit-mode').innerText =
            command.forfeit_mode[0].toUpperCase() + command.forfeit_mode.substring(1).toLowerCase();
          document.getElementById('remaining-mode').innerText =
            command.remaining_mode[0].toUpperCase() + command.remaining_mode.substring(1).toLowerCase();
          hintCost = Number(command.hint_cost);
          document.getElementById('points-per-check').innerText = command.location_check_points.toString();

          // Update the local data package cache if necessary
          if (!localStorage.getItem('dataPackageVersion') || !localStorage.getItem('dataPackage') ||
            command.datapackage_version !== localStorage.getItem('dataPackageVersion')) {
            requestDataPackage();
          } else {
            // Load the location and item maps into memory
            buildItemAndLocationData(JSON.parse(localStorage.getItem('dataPackage')));
          }

          // Authenticate with the server
          const romName = await readFromAddress(ROMNAME_START, ROMNAME_SIZE);
          const connectionData = {
            cmd: 'Connect',
            game: 'Super Metroid',
            name: btoa(new TextDecoder().decode(romName)), // Base64 encoded rom name
            uuid: getClientId(),
            tags: ['Super Metroid Client'],
            password: serverPassword,
            version: ARCHIPELAGO_PROTOCOL_VERSION,
          };
          serverSocket.send(JSON.stringify([connectionData]));
          break;

        case 'Connected':
          // Save the last server that was successfully connected to
          lastServerAddress = address;

          // Reset reconnection info if necessary
          reconnectAttempts = 0;

          // Store the reported location check data from the server. They are arrays of locationIds
          checkedLocations = command.checked_locations;
          missingLocations = command.missing_locations;

          // In case the user replaced the ROM without disconnecting from the AP Server or SNI, treat every new
          // 'Connected' message as if it means a new ROM was discovered
          itemsReceived = [];

          // Set the hint cost text
          document.getElementById('hint-cost').innerText =
            (Math.round((hintCost / 100) * (checkedLocations.length + missingLocations.length))).toString();

          // Update header text
          serverStatus.classList.remove('disconnected');
          serverStatus.innerText = 'Connected';
          serverStatus.classList.add('connected');

          // Save the list of players provided by the server
          players = command.players;

          // Save information about the current player
          playerTeam = command.team;
          playerSlot = command.slot;

          snesInterval = setInterval(async () => {
            try{
              // Prevent the interval from running concurrently with itself. If more than one iteration of this
              // function is active at any given time, it wil result in reading and writing areas of the SRAM out of
              // order, causing the item index store in the SRAM to be invalid
              if (!snesIntervalComplete) {
                return;
              }

              // The SNES interval is now in progress, don't start another one
              snesIntervalComplete = false;

              // Send a bounce packet once every five minutes or so
              const currentTime = new Date().getTime();
              if (currentTime > (lastBounce + 300000)){
                if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                  lastBounce = currentTime;
                  serverSocket.send(JSON.stringify([{
                    cmd: 'Bounce',
                    slots: [playerSlot],
                    data: currentTime,
                  }]));
                }
              }

              // Fetch the current game mode
              const gameMode = await readFromAddress(WRAM_START + 0x998, 1);

              // If the game has been completed
              if (gameMode && ENDGAME_MODES.includes(gameMode)) {
                // Update the gameCompleted status in the client if it has not already been updated
                if (!gameCompleted) {
                  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                    serverSocket.send(JSON.stringify([{
                      cmd: 'StatusUpdate',
                      status: CLIENT_STATUS.CLIENT_GOAL,
                    }]));
                    gameCompleted = true;
                  }
                }

                // Do not continue interacting with the ROM if the game is in an endgame state
                snesIntervalComplete = true;
                return;
              }

              // The Super Metroid Randomizer ROM keeps an internal array containing locations which the player
              // has collected the item from. In this section, we scan that array beginning at the index of the last
              // known location the player checked.
              const checkArrayData = await readFromAddress(RECV_PROGRESS_ADDR + 0x680, 4);
              const checkArrayIndex = checkArrayData[0] | (checkArrayData[1] << 8);
              const checkArrayLength = checkArrayData[2] | (checkArrayData[3] << 8);

              // Track any new location checks, and send them all in a single report later
              const newLocationChecks = [];

              // Fetch item information for each location check not yet acknowledged by the client and report it
              // to the AP server
              for (let index = checkArrayIndex; index < checkArrayLength; index++) {
                const itemAddressOffset = index * 8; // Each entry in the array is eight bytes long
                const itemData = await readFromAddress(RECV_PROGRESS_ADDR + 0x700 + itemAddressOffset, 8);
                // const worldId = itemData[0] | (itemData[1] << 8);
                // const itemId = itemData[2] | (itemData[3] << 8);
                const itemIndex = (itemData[4] | (itemData[5] << 8)) >> 3;
                // TODO: Ask lordlou what is stored in indexes 7 and 8

                // TODO: Ask lordlou about AP location index reservation
                newLocationChecks.push(LOCATIONS_START_ID + itemIndex);
              }

              // If new locations have been checked, send those checks to the AP server
              if (newLocationChecks.length > 0) {
                if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                  serverSocket.send(JSON.stringify([{
                    cmd: 'LocationChecks',
                    locations: newLocationChecks,
                  }]));
                }

                // Update the ROM with the index of the item which has been acknowledged by the client
                const indexUpdateData = new Uint8Array(2);
                indexUpdateData.set([
                  (checkedLocations - 1) & 0xFF,
                  ((checkedLocations - 1) >> 8) & 0xFF,
                ]);
                await writeToAddress(RECV_PROGRESS_ADDR + 0x680, indexUpdateData);
              }

              // If the client is currently accepting items, send those items to the ROM
              if (receiveItems) {
                const receivedItemData = await readFromAddress(RECV_PROGRESS_ADDR + 0x600, 4);
                const whatIsThis = receivedItemData[0] | (receivedItemData[1] << 8);
                const receivedItemCount = receivedItemData[2] | (receivedItemData[3] << 8);

                if (receivedItemCount < itemsReceived.length) {
                  // TODO: Write logic for sending pending items to the ROM
                }
              }

              // Keep on loopin'
              snesIntervalComplete = true;
            } catch (err) {
              await window.logging.writeToLog(err.message);

              appendConsoleMessage('There was a problem communicating with your SNES device. Please ensure it ' +
                'is powered on, the ROM is loaded, and it is connected to your computer.');

              // Do not send requests to the SNES device if the device is unavailable
              clearInterval(snesInterval);
              snesIntervalComplete = true;

              // Disconnect from the AP server
              if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
                serverSocket.close();
              }

              snesDevice = null;
              setTimeout(initializeSNIConnection, 5000);
              snesIntervalComplete = true;
            }
          });
          break;

        case 'ConnectionRefused':
          serverStatus.classList.remove('connected');
          serverStatus.innerText = 'Not Connected';
          serverStatus.classList.add('disconnected');
          if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
            if (command.errors.includes('InvalidPassword')) {
              appendConsoleMessage(serverPassword === null ?
                'A password is required to connect to the server. Please use /connect [server] [password]' :
                'The password you provided was rejected by the server.'
              );
            } else {
              appendConsoleMessage(`Error while connecting to AP server: ${command.errors.join(', ')}.`);
            }
            serverAuthError = true;
            serverSocket.close();
          }
          break;

        case 'ReceivedItems':
          // Save received items in the array of items to be sent to the SNES, if they have not been sent already
          command.items.forEach((item) => {
            // Items from locations with id 0 or lower are special cases, and should always be allowed
            if (item.location <= 0) { return itemsReceived.push(item); }

            if (itemsReceived.find((ir) =>
              ir.item === item.item && ir.location === item.location && ir.player === item.player
            )) { return; }
            itemsReceived.push(item);
          });
          break;

        case 'LocationInfo':
          // This packed is received as a confirmation from the server that a location has been scouted.
          // Once the server confirms a scout, it sends the confirmed data back to the client. Here, we
          // store the confirmed scouted locations in an object.
          command.locations.forEach((location) => {
            // location = [ item, location, player ]
            if (!scoutedLocations.hasOwnProperty(location.location)) {
              scoutedLocations[location.location] = {
                item: location[0],
                player: location[2],
              };
            }
          });
          break;

        case 'RoomUpdate':
          // Update sidebar with info from the server
          if (command.hasOwnProperty('version')) {
            document.getElementById('server-version').innerText =
              `${command.version.major}.${command.version.minor}.${command.version.build}`;
          }

          if (command.hasOwnProperty('forfeit_mode')) {
            document.getElementById('forfeit-mode').innerText =
              command.forfeit_mode[0].toUpperCase() + command.forfeit_mode.substring(1).toLowerCase();
          }

          if (command.hasOwnProperty('remaining_mode')) {
            document.getElementById('remaining-mode').innerText =
              command.remaining_mode[0].toUpperCase() + command.remaining_mode.substring(1).toLowerCase();
          }

          if (command.hasOwnProperty('hint_cost')) {
            hintCost = Number(command.hint_cost);
            document.getElementById('hint-cost').innerText =
              (Math.floor((hintCost / 100) * (checkedLocations.length + missingLocations.length))).toString();
          }

          if (command.hasOwnProperty('location_check_points')) {
            document.getElementById('points-per-check').innerText = command.location_check_points.toString();
          }

          if (command.hasOwnProperty('hint_points')) {
            document.getElementById('hint-points').innerText = command.hint_points.toString();
          }
          break;

        case 'Print':
          appendConsoleMessage(command.text);
          break;

        case 'PrintJSON':
          appendFormattedConsoleMessage(command.data);
          break;

        case 'DataPackage':
          // Save updated data package into localStorage
          if (command.data.version !== 0) { // Unless this is a custom package, denoted by version zero
            localStorage.setItem('dataPackageVersion', command.data.version);
            localStorage.setItem('dataPackage', JSON.stringify(command.data));
          }
          buildItemAndLocationData(command.data);
          break;

        case 'Bounced':
          // This is a response to a makeshift keep-alive packet requested every five minutes.
          // Nothing needs to be done in response to this message
          break;

        default:
          // Unhandled events are ignored
          break;
      }
    }
  };

  serverSocket.onclose = (event) => {
    const serverStatus = document.getElementById('server-status');
    serverStatus.classList.remove('connected');
    serverStatus.innerText = 'Not Connected';
    serverStatus.classList.add('disconnected');

    // If the user cleared the server address, do nothing
    const serverAddress = document.getElementById('server-address').value;
    if (!serverAddress) { return; }

    // Attempt to reconnect to the AP server
    if (snesDevice === null) { return; }

    setTimeout(() => {
      // Do not attempt to reconnect if a server connection exists already. This can happen if a user attempts
      // to connect to a new server after connecting to a previous one
      if (serverSocket && serverSocket.readyState === WebSocket.OPEN) { return; }

      // If the socket was closed in response to an auth error, do not reconnect
      if (serverAuthError) { return; }

      // Do not exceed the limit of reconnection attempts
      if (++reconnectAttempts > maxReconnectAttempts) {
        appendConsoleMessage('Archipelago server connection lost. The connection closed unexpectedly. ' +
          'Please try to reconnect, or restart the client.');
        return;
      }

      appendConsoleMessage(`Connection to AP server lost. Attempting to reconnect ` +
        `(${reconnectAttempts} of ${maxReconnectAttempts})`);
      connectToServer(address, serverPassword);
    }, 5000);
  };

  serverSocket.onerror = (event) => {
    if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
      appendConsoleMessage('Archipelago server connection lost. The connection closed unexpectedly. ' +
        'Please try to reconnect, or restart the client.');
      serverSocket.close();
    }
  };
};

const getClientId = () => {
  let clientId = localStorage.getItem('clientId');
  if (!clientId) {
    clientId = (Math.random() * 10000000000000000).toString();
    localStorage.setItem('clientId', clientId);
  }
  return clientId;
};

const sendMessageToServer = (message) => {
  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
    serverSocket.send(JSON.stringify([{
      cmd: 'Say',
      text: message,
    }]));
  }
};

const serverSync = () => {
  if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
    serverSocket.send(JSON.stringify([{ cmd: 'Sync' }]));
  }
};

const requestDataPackage = () => {
  if (!serverSocket || serverSocket.readyState !== WebSocket.OPEN) { return; }
  serverSocket.send(JSON.stringify([{
    cmd: 'GetDataPackage',
  }]));
};

const sendLocationChecks = (locationIds) => {
  locationIds.forEach((id) => checkedLocations.push(id));
  serverSocket.send(JSON.stringify([{
    cmd: 'LocationChecks',
    locations: locationIds,
  }]));
};

const buildItemAndLocationData = (dataPackage) => {
  itemsById = {};
  const locationMap = {};
  Object.keys(dataPackage.games).forEach((gameName) => {
    Object.keys(dataPackage.games[gameName].item_name_to_id).forEach((itemName) => {
      itemsById[dataPackage.games[gameName].item_name_to_id[itemName]] = itemName;
    });

    Object.keys(dataPackage.games[gameName].location_name_to_id).forEach((locationName) => {
      locationMap[dataPackage.games[gameName].location_name_to_id[locationName]] = locationName;
    });
  });
  buildLocationData(locationMap);
};

/**
 * Build two global objects which are used to reference location data
 * @param locations An object of { locationId: locationName, ... }
 */
const buildLocationData = (locations) => {
  locationMap = locations;
  const locationIds = Object.keys(locations);
  const locationNames = Object.values(locations);

  Object.keys(UNDERWORLD_LOCATIONS).forEach((uwLocationName) => {
    locationsById['underworld'][locationIds[locationNames.indexOf(uwLocationName)]] = {
      name: uwLocationName,
      locationId: Number(locationIds[locationNames.indexOf(uwLocationName)]),
      roomId: UNDERWORLD_LOCATIONS[uwLocationName][0],
      mask: UNDERWORLD_LOCATIONS[uwLocationName][1],
    }

    if (!locationsByRoomId['underworld'].hasOwnProperty(UNDERWORLD_LOCATIONS[uwLocationName][0])) {
      locationsByRoomId['underworld'][UNDERWORLD_LOCATIONS[uwLocationName][0]] = [];
    }
    locationsByRoomId['underworld'][UNDERWORLD_LOCATIONS[uwLocationName][0]].push({
      name: uwLocationName,
      locationId: Number(locationIds[locationNames.indexOf(uwLocationName)]),
      roomId: UNDERWORLD_LOCATIONS[uwLocationName][0],
      mask: UNDERWORLD_LOCATIONS[uwLocationName][1],
    });
  });

  Object.keys(OVERWORLD_LOCATIONS).forEach((owLocationName) => {
    locationsById['overworld'][locationIds[locationNames.indexOf(owLocationName)]] = {
      name: owLocationName,
      locationId: Number(locationIds[locationNames.indexOf(owLocationName)]),
      screenId: OVERWORLD_LOCATIONS[owLocationName],
      mask: null,
    };

    if (!locationsByRoomId['overworld'].hasOwnProperty(OVERWORLD_LOCATIONS[owLocationName])) {
      locationsByRoomId['overworld'][OVERWORLD_LOCATIONS[owLocationName]] = [];
    }
    locationsByRoomId['overworld'][OVERWORLD_LOCATIONS[owLocationName]].push({
      name: owLocationName,
      locationId: Number(locationIds[locationNames.indexOf(owLocationName)]),
      screenId: OVERWORLD_LOCATIONS[owLocationName],
      mask: null,
    });
  });

  Object.keys(NPC_LOCATIONS).forEach((npcLocationName) => {
    locationsById['npc'][locationIds[locationNames.indexOf(npcLocationName)]] = {
      name: npcLocationName,
      locationId: Number(locationIds[locationNames.indexOf(npcLocationName)]),
      screenId: NPC_LOCATIONS[npcLocationName],
      mask: null,
    };

    if (!locationsByRoomId['npc'].hasOwnProperty(NPC_LOCATIONS[npcLocationName])) {
      locationsByRoomId['npc'][NPC_LOCATIONS[npcLocationName]] = [];
    }
    locationsByRoomId['npc'][NPC_LOCATIONS[npcLocationName]].push({
      name: npcLocationName,
      locationId: Number(locationIds[locationNames.indexOf(npcLocationName)]),
      screenId: NPC_LOCATIONS[npcLocationName],
      mask: null,
    });
  });

  Object.keys(MISC_LOCATIONS).forEach((miscLocationName) => {
    locationsById['misc'][locationIds[locationNames.indexOf(miscLocationName)]] = {
      name: miscLocationName,
      locationId: Number(locationIds[locationNames.indexOf(miscLocationName)]),
      roomId: MISC_LOCATIONS[miscLocationName][0],
      mask: MISC_LOCATIONS[miscLocationName][1],
    };

    if (!locationsByRoomId['misc'].hasOwnProperty(MISC_LOCATIONS[miscLocationName][0])) {
      locationsByRoomId['misc'][MISC_LOCATIONS[miscLocationName][0]] = [];
    }
    locationsByRoomId['misc'][MISC_LOCATIONS[miscLocationName][0]].push({
      name: miscLocationName,
      locationId: Number(locationIds[locationNames.indexOf(miscLocationName)]),
      roomId: MISC_LOCATIONS[miscLocationName][0],
      mask: MISC_LOCATIONS[miscLocationName][1],
    });
  });
};
