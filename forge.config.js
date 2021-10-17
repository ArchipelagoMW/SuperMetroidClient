const path = require('path');

module.exports = {
  packagerConfig: {
    name: "Super Metroid Client",
    icon: path.join(__dirname, "icon.ico"),
    prune: true,
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        authors: "Archipelago",
        copyright: `${new Date().getFullYear()} Chris Wilson`,
        description: "The Archipelago client for Super Metroid",
        iconUrl: path.join(__dirname, 'icon.ico'),
        setupExe: "Super Metroid Client Setup.exe",
        setupIcon: path.join(__dirname, 'icon.ico'),
        name: "Super Metroid Client"
      }
    },
    {
      name: "@electron-forge/maker-zip",
    },
  ],
};