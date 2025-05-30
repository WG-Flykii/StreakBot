// Originally made by Flykii for the Worldguessr Discord. Join at https://discord.gg/nfebQwes6a !

import { Client, GatewayIntentBits, Partials, ChannelType, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } from 'discord.js';
import fs from 'fs';
import axios from 'axios';
import path from 'path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PB_STREAK_PATH = path.join(__dirname, 'data/pb_streak.json');
const LB_STREAK_PATH = path.join(__dirname, 'data/lb_streak.json');
const SERVER_CONFIG_PATH = path.join(__dirname, 'data/server_config.json');

let personalBestStreaks = loadJsonFile(PB_STREAK_PATH, {});
let leaderboardStreaks = loadJsonFile(LB_STREAK_PATH, {});
let serverConfig = loadJsonFile(SERVER_CONFIG_PATH, {});

const BOT_TOKEN = process.env.BOT_TOKEN; // Token for the discord bot

const getCreateQuizId = (action) => serverConfig[action.guild.id].createQuizId; // Channel to send sendPrivateMessageOffer
const getQuizId = (action) => serverConfig[action.guild.id].quizId; // Main quiz channel
const getAdminId = (action) => serverConfig[action.guild.id].adminId; // Channel to make sendPrivateMessageOffer

import { COUNTRIES, COUNTRY_LOOKUP } from './constants/countries_data.js';
import { mapData, mapNames, maps, mapAliases, mapImages, refreshMaps } from './constants/maps_data.js';
import { loadJsonFile, saveJsonFile } from './utils.js';

const getDay = (date = null) => new Date(date).toISOString().split('T')[0];

// Initializes resources
async function initializeResources() {
  try {
    await getBrowser();
    console.log("Initialized browser");

    if (typeof preloadLocationCache === 'function') {
      await preloadLocationCache();
      console.log("Preloaded location cache");
    } else {
      console.log("Function preloadLocationCache is unavailable, ignored");
    }

    console.log("Resources initialized and ready for fast quiz generation");
    return true;
  } catch (error) {
    console.error("Error initializing resources:", error);
    return false;
  }
}

function resolveMapName(input) {
  if (!input) return null;
  return mapAliases[input.toLowerCase()] || null;
}

let browserPool = null;
let isInitializingBrowser = false;
const MAX_BROWSER_AGE = 10 * 60 * 1000; // 30 mins
let browserStartTime = null;
let browserPage = null;
const locationCache = {};
const mapCache = {};
if (typeof quizzesByChannel === 'undefined') var quizzesByChannel = {};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

async function getBrowser() {
  if (isInitializingBrowser) {
    while (isInitializingBrowser) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return browserPool;
  }

  const expired = !browserPool || (Date.now() - browserStartTime > MAX_BROWSER_AGE);
  if (expired) {
    isInitializingBrowser = true;

    if (browserPool) {
      try {
        await browserPool.close();
        browserPage = null;
      } catch (err) {
        console.error("Error closing old browser:", err);
      }
    }

    try {
      browserPool = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions'
        ]
      });
      browserStartTime = Date.now();
      console.log("Browser launched.");

      browserPage = await browserPool.newPage();
      await browserPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    } catch (err) {
      console.error("Failed to launch browser:", err);
      browserPool = null;
    }

    isInitializingBrowser = false;
  }

  return browserPool;
}



function normalizeCountry(countryName) {
  const lookupKey = countryName.toLowerCase();
  if (COUNTRY_LOOKUP[lookupKey]) {
    return COUNTRY_LOOKUP[lookupKey];
  }

  for (const key of Object.keys(COUNTRY_LOOKUP)) {
    if (lookupKey.includes(key) || key.includes(lookupKey)) {
      return COUNTRY_LOOKUP[key];
    }
  }

  return null;
}

async function getCountryFromCoordinates(lat, lng) {
  const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;

  if (locationCache[cacheKey]) {
    return locationCache[cacheKey];
  }

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=5&addressdetails=1`;

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'GeoBot/1.0',
        'Accept-Language': 'en'
      }
    });

    const address = response.data?.address;
    let country = address?.country;
    let subdivision =
      address?.state ||
      address?.province ||
      address?.region ||
      address?.territory ||
      address?.state_district ||
      address?.county ||
      address?.administrative ||
      address?.municipality ||
      address?.district ||
      address?.city ||
      address?.town ||
      address?.village ||
      address?.locality ||
      address?.borough ||
      address?.suburb ||
      address?.neighbourhood ||
      address?.hamlet ||
      address?.ISO3166_2_lvl4 ||
      address?.ISO3166_2_lvl6 ||
      address?.political ||
      'Unknown subdivision';

    if (country === 'United States') {
      if (subdivision.toLowerCase().includes('us virgin islands')) country = 'us virgin islands';
      else if (subdivision.toLowerCase().includes('puerto rico')) country = 'puerto rico';
      else if (subdivision.toLowerCase().includes('guam')) country = 'guam';
      else if (subdivision.toLowerCase().includes('american samoa')) country = 'american samoa';
      else if (subdivision.toLowerCase().includes('northern mariana islands')) country = 'northern mariana islands';
    }

    const result = {
      country: country?.toLowerCase() || 'Unknown location',
      subdivision: subdivision || 'Unknown subdivision',
      address
    };

    if (result.country === 'Unknown location') return null;

    locationCache[cacheKey] = result;
    return result;
  } catch (error) {
    console.error('Error with Nominatim API:', error);
    return { country, subdivision, address };
  }
}



function getWorldGuessrEmbedUrl(location) {
  if (!location) return null;

  const baseUrl = 'https://www.worldguessr.com/svEmbed';
  const params = new URLSearchParams({
    nm: 'true',
    npz: 'false',
    showRoadLabels: 'false',
    lat: location.lat,
    long: location.lng,
    showAnswer: 'false'
  });

  if (location.heading !== undefined) params.append('heading', location.heading);
  if (location.pitch !== undefined) params.append('pitch', location.pitch);
  if (location.zoom !== undefined) params.append('zoom', location.zoom);

  return `${baseUrl}?${params.toString()}`;
}


async function fetchMapLocations(mapName) {
  const slug = maps[mapName];
  if (!slug) throw new Error(`Unknown map name: ${mapName}`);

  const url = `https://api.worldguessr.com/mapLocations/${slug}`;

  if (mapCache[slug]) return mapCache[slug];

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch map: ${mapName}`);

  const data = await res.json();
  if (!data.ready || !Array.isArray(data.locations)) {
    throw new Error(`Map "${mapName}" is not ready or contains no locations.`);
  }

  mapCache[slug] = data.locations;
  return data.locations;
}

async function preloadLocationCache() {
  console.log("Preloading known locations...");

  for (const mapName of mapNames) {
    try {
      const locations = await fetchMapLocations(mapName);
      for (let i = locations.length-1; i >= 0; i--) {
        if (i >= locations.length) break; // To handle concurrent bad loc deletions
        const location = locations[i];
        const cacheKey = `${location.lat.toFixed(6)},${location.lng.toFixed(6)}`;
        if (!locationCache[cacheKey]) {
          try {
            const locationInfo = await getCountryFromCoordinates(location.lat, location.lng);
            if (!locationInfo || !locationInfo.country) {
              console.log(`Unknown location for coordinates ${location.lat}, ${location.lng}. Deleting from map ${mapName}.`);
              mapCache[maps[mapName]].splice(i, 1);
              continue;
            }
            locationCache[cacheKey] = locationInfo;
          } catch (e) {
            console.error(`Error preloading cache for ${cacheKey}:`, e);
          }
        }
      }
    } catch (e) {
      console.error(`Error loading map ${mapName}:`, e);
    }
  }

  console.log(`Location cache preloaded with ${Object.keys(locationCache).length} entries`);
}



async function takeScreenshot(url, channelId) {
  let page;
  let newPageCreated = false;

  try {
    const browser = await getBrowser();

    page = await browser.newPage();
    newPageCreated = true;

    await page.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1
    });

    const pageTimeout = setTimeout(() => {
      console.log("Global timeout exceeded, attempting screenshot anyway");
    }, 4000);

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.evaluateOnNewDocument(() => {
      window._resourcesLoaded = false;
      window._canvasReady = false;

      const originalRequestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = function(callback) {
        window._canvasReady = true;
        return originalRequestAnimationFrame(callback);
      };
    });

    console.log(`Navigating to URL: ${url} for channel ${channelId}`);
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 50000
    });

    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.move(650, 360, { steps: 2 });
    await page.mouse.up();

    try {
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return canvas && canvas.offsetWidth > 0;
      }, { timeout: 5000 });
    } catch (e) {
      console.log("No canvas found, attempting to capture anyway");
    }

    const startTime = Date.now();
    let canProceed = false;

    while (!canProceed && (Date.now() - startTime < 3000)) {
      canProceed = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return false;

        try {
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

          let nonBlackPixels = 0;
          for (let i = 0; i < data.length; i += 30000) {
            if (data[i] > 20 || data[i+1] > 20 || data[i+2] > 20) nonBlackPixels++;
            if (nonBlackPixels > 3) return true;
          }

          return false;
        } catch(e) {
          return window._canvasReady;
        }
      });

      if (!canProceed) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    clearTimeout(pageTimeout);

    const screenshotBuffer = await page.screenshot({
      fullPage: false,
      clip: {
        x: 0,
        y: -3,
        width: 1280,
        height: 720
      }
    });

    const optimizedBuffer = await sharp(screenshotBuffer)
      .resize(1280, 715)
      .jpeg({ quality: 65 })
      .toBuffer();

    return optimizedBuffer;
  } catch (error) {
    console.error(`Error taking screenshot for channel ${channelId}: ${error.message}`);
    throw error;
  } finally {
    if (page && newPageCreated) {
      try {
        await page.close();
      } catch (err) {
        console.error("Error closing page:", err);
      }
    }
  }
}


function checkCountryGuess(guess, correctCountry) {
  if (!guess || !correctCountry) return false;

  const normalizedGuess = guess.toLowerCase();
  const normalizedCorrect = correctCountry.toLowerCase();

  if (normalizedGuess === normalizedCorrect) return true;

  const countryKey = normalizeCountry(normalizedCorrect);

  if (countryKey && COUNTRIES[countryKey]) {
    return COUNTRIES[countryKey].aliases.some(alias =>
      alias.toLowerCase() === normalizedGuess
    );
  }

  return normalizedGuess === normalizedCorrect;
}


function isQuizChannel(channel, quizId) {
  if (channel.id === quizId) return true;
  if (channel.isThread() && channel.parentId === quizId) return true;
  return false;
}

async function newLoc(channel, quizId, mapName = null, userId = null) {
  if (!isQuizChannel(channel, quizId)) {
    await channel.send("Quizzes can only be played in the designated channel or its threads.");
    return;
  }

  try {
    let selectedMapName = null;

    if (mapName) {
      selectedMapName = resolveMapName(mapName);
      if (!selectedMapName || !mapNames.includes(selectedMapName)) {
        await channel.send(`Map "${mapName}" not found.\nAvailable maps: ${mapNames.join(', ')}`);
        return;
      }
    } else {
      selectedMapName = mapNames[Math.floor(Math.random() * mapNames.length)];
    }

    const loadingMessage = await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🌍 Loading Quiz...')
        .setDescription('Preparing your challenge, please wait...')
        .setColor('#3498db')]
    });

    const averageTime = quizzesByChannel[channel.id]?.averageTime || 0;
    const currentStreak = quizzesByChannel[channel.id]?.currentStreak || 0;

    quizzesByChannel[channel.id] = {
      message: null,
      startTime: null,
      averageTime: averageTime,
      solved: false,
      mapName: selectedMapName,
      currentStreak: currentStreak,
      participants: [],
      startedBy: userId,
      location: null,
      country: null
    };

    const mapLocations = await fetchMapLocations(selectedMapName);
    if (!mapLocations || mapLocations.length === 0) {
      await loadingMessage.delete().catch(e => console.error("Couldn't delete loading message:", e));
      await channel.send("Could not fetch locations for this map.");
      return;
    }

    const locationIndex = Math.floor(Math.random() * mapLocations.length);
    const location = mapLocations[locationIndex];
    quizzesByChannel[channel.id].location = location;

    const embedUrl = getWorldGuessrEmbedUrl(location);
    if (!embedUrl) {
      await loadingMessage.delete().catch(e => console.error("Couldn't delete loading message:", e));
      await channel.send("Error generating quiz location.");
      return;
    }

    let locationInfo;
    while (!locationInfo || !locationInfo.country) {
      locationInfo = await getCountryFromCoordinates(location.lat, location.lng);

      if (!locationInfo || !locationInfo.country) {
        await loadingMessage.delete().catch(e => console.error("Couldn't delete loading message:", e));
        await channel.send("Error fetching country for the location. Deleting it from the map and retrying...");
        mapCache[maps[selectedMapName]].splice(locationIndex, 1);
        newLoc(channel, quizId, mapName, userId);
        return;
      }
    }

    const screenshotBuffer = await takeScreenshot(embedUrl, channel.id);

    quizzesByChannel[channel.id].country = locationInfo.country;
    quizzesByChannel[channel.id].subdivision = locationInfo.subdivision;

    const attachment = new AttachmentBuilder(screenshotBuffer, { name: 'quiz_location.jpg' });

    const embed = new EmbedBuilder()
      .setTitle(`🌍 Country streak – ${selectedMapName}`)
      .setDescription('In which country is this location? Use `!g <country>` to guess!')
      .setImage('attachment://quiz_location.jpg')
      .setColor('#3498db')
      .setFooter({ text: `Map: ${selectedMapName} | Current Streak: ${currentStreak}` });

    const quizMessage = await channel.send({ embeds: [embed], files: [attachment] });
    quizzesByChannel[channel.id].message = quizMessage;
    quizzesByChannel[channel.id].startTime = Date.now();

    await loadingMessage.delete().catch(e => console.error("Couldn't delete loading message:", e));

    console.log(`New quiz started in channel ${channel.id}. Map: ${selectedMapName}, Answer: ${locationInfo.country}`);
    console.log(JSON.stringify(locationInfo.address, null, 2));

  } catch (error) {
    console.error(`Error starting quiz: ${error.message}`);
    await channel.send("An error occurred while creating the quiz. Please do !stop, and try again.");
  }
}

// If a guess is right, give info and call newLoc
// If a guess is wrong, end the game and give info
async function handleGuess(message, guess) {
  if (!guess) return;

  const channelId = message.channel.id;
  const quiz = quizzesByChannel[channelId];
  if (!quiz || quiz.solved) return;

  const subdivision = quiz.subdivision || 'Unknown subdivision';
  const quizId = getQuizId(message);

  if (!quiz.participants.some(p => p.id === message.author.id)) {
    quiz.participants.push({ id: message.author.id, username: message.author.username });
  }

  const correctCountry = quiz.country;
  if (!correctCountry) return;

  const countryInfo = COUNTRIES[correctCountry.toLowerCase()] ||
      COUNTRIES[normalizeCountry(correctCountry.toLowerCase())];

  const isCorrect = checkCountryGuess(guess, correctCountry);
  const { lat, lng } = quiz.location;

  if (isCorrect) {
    const userId = message.author.id;
    const username = message.author.username;
    const mapName = quiz.mapName;
    const quizTime = Date.now() - quiz.startTime;

    quiz.solved = true;
    quiz.currentStreak++;
    quiz.averageTime += (quizTime - quiz.averageTime) / quiz.currentStreak; // Math trick

    if (!personalBestStreaks[userId]) {
      personalBestStreaks[userId] = {};
    }

    if (!personalBestStreaks[userId][mapName]) {
      personalBestStreaks[userId][mapName] = {
        streak: quiz.currentStreak,
        averageTime: quiz.averageTime,
        lastUpdate: Date.now(),
        username: username
      };
    } else if (quiz.currentStreak > personalBestStreaks[userId][mapName].streak) {
      personalBestStreaks[userId][mapName] = {
        streak: quiz.currentStreak,
        averageTime: quiz.averageTime,
        lastUpdate: Date.now(),
        username: username
      };
    }

    if (!leaderboardStreaks[mapName]) {
      leaderboardStreaks[mapName] = [];
    }

    const userIndex = leaderboardStreaks[mapName].findIndex(entry => entry.userId === userId);

    const leaderboardEntry = {
      userId: userId,
      username: username,
      streak: quiz.currentStreak,
      averageTime: quiz.averageTime,
      lastUpdate: Date.now()
    };

    if (userIndex === -1) {
      leaderboardStreaks[mapName].push(leaderboardEntry);
    } else if (quiz.currentStreak > leaderboardStreaks[mapName][userIndex].streak) {
      leaderboardStreaks[mapName][userIndex] = leaderboardEntry;
    }

    leaderboardStreaks[mapName].sort((a, b) => {
      if (b.streak !== a.streak) {
        return b.streak - a.streak;
      }
      return a.averageTime - b.averageTime;
    });

    saveJsonFile(PB_STREAK_PATH, personalBestStreaks);
    saveJsonFile(LB_STREAK_PATH, leaderboardStreaks);

    const flag = countryInfo?.flag || '';

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${flag} Correct!`)
          .setDescription(`You guessed it right! The location is in **${correctCountry}**.`)
          .addFields(
            { name: 'Subdivision', value: `**${subdivision}**`, inline: true },
            { name: 'Time This Round', value: formatTime(quizTime), inline: true },
            { name: 'Average Time', value: formatTime(quiz.averageTime), inline: true },
            { name: 'Current Streak', value: `${quiz.currentStreak}`, inline: true },
            {
              name: "Exact Location",
              value: `[Click here to view on Street View](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}&heading=0&pitch=0)`
            }
          )
          .setColor('#2ecc71')
      ]
    });

    quizzesByChannel[channelId] = {
      message: quiz.message,
      startTime: Date.now(),
      averageTime: quiz.averageTime,
      solved: true,
      mapName: quiz.mapName,
      currentStreak: quiz.currentStreak,
      participants: [],
      startedBy: quiz.startedBy,
      location: quiz.location,
      country: correctCountry,
      subdivision: quiz.subdivision
    };

    setTimeout(async () => {
      await newLoc(message.channel, quizId, quiz.mapName, message.author.id);
    }, 300);

  } else {
    const flag = countryInfo?.flag || '';

    const quizTime = Date.now() - quiz.startTime;
    const personalBest = personalBestStreaks[message.author.id]?.[quiz.mapName]?.streak || 0;

    const participantsList = quiz.participants.length > 0
      ? quiz.participants.map(p => p.username).join(', ')
      : 'None';

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('❌ Game Over!')
          .setDescription(`Wrong guess! The correct answer was **${correctCountry}** ${flag}.`)
          .addFields(
            { name: 'Subdivision', value: `**${subdivision}**`, inline: true },
            { name: 'Time This Round', value: formatTime(quizTime), inline: true },
            { name: 'Average Time', value: formatTime(quiz.averageTime), inline: true },
            { name: 'Final Streak', value: `${quiz.currentStreak}`, inline: true },
            { name: 'Personal Best', value: `${personalBest}`, inline: true },
            { name: 'Participants', value: participantsList, inline: false },
            {
              name: "Exact Location",
              value: `[Click here to view on Street View](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}&heading=0&pitch=0)`
            }
          )
          .setColor('#e74c3c')
      ]
    });
    quizzesByChannel[channelId] = {
      message: null,
      startTime: Date.now(),
      solved: true,
      mapName: quiz.mapName,
      currentStreak: 0,
      participants: [],
      startedBy: quiz.startedBy,
      location: null,
      country: null,
      subdivision: null
    };
  }
}



function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const ms = Math.floor((milliseconds % 1000) / 10);

  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

async function createPrivateThread(interaction, userId) {
  try {
    if (interaction.deferred || interaction.replied) {
      console.log('Interaction already acknowledged');
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const quizChannel = await client.channels.fetch(getQuizId(interaction));
    if (!quizChannel) {
      return interaction.editReply({ content: 'Quiz channel not found!', ephemeral: true });
    }

    const threadName = `🏁 Private Quiz - ${interaction.user.username}`;
    const thread = await quizChannel.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      reason: `Private session for ${interaction.user.username}`
    });

    await thread.members.add(userId);
    const announcementChannel = await client.channels.fetch(getAdminId(interaction));

    if (announcementChannel && announcementChannel.isTextBased()) {
      await announcementChannel.send(`🧵 A new private thread was created by <@${userId}>!\nJoin it here: <https://discord.com/channels/${interaction.guild.id}/${thread.id}>`);
    }

    scheduleThreadInactivityCheck(thread.id);

    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🌍 Welcome to Your Private Session!')
          .setDescription('This is a private thread where you can play without interruptions. You can invite others using `!invite @<user>`.')
          .addFields(
            { name: 'Starting a Game', value: 'Use `!play <map>` to begin', inline: false },
            { name: 'Inviting Others', value: 'Use `!invite @<user>` to add friends', inline: false },
            { name: 'Kicking Users', value: 'Use `!kick @<user>` kick the user', inline: false }
          )
          .setColor('#3498db')
      ]
    });

    return interaction.editReply({
      content: `Your private quiz thread has been created! [Join thread](https://discord.com/channels/${interaction.guild.id}/${thread.id})`,
      ephemeral: true
    });
  } catch (error) {
    console.error('Error creating thread:', error);

    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({
        content: 'There was an error creating your private thread. Please try again later.',
        ephemeral: true
      });
    } else {
      return interaction.editReply({
        content: 'There was an error creating your private thread. Please try again later.',
        ephemeral: true
      });
    }
  }
}

function scheduleThreadInactivityCheck(threadId) {
  setTimeout(async () => {
    try {
      const thread = await client.channels.fetch(threadId);
      if (thread && thread.isThread() && !thread.archived) {
        const lastMessage = await thread.messages.fetch({ limit: 1 });
        const lastActivity = lastMessage.first()?.createdTimestamp || thread.createdTimestamp;
        const now = Date.now();
        const hoursInactive = (now - lastActivity) / (1000 * 60 * 60);

        if (hoursInactive >= 24) {
          await thread.delete(`Thread inactive for over 24h`);
          console.log(`Deleted inactive thread: ${thread.name}`);
        } else {
          const remainingTimeMs = (24 - hoursInactive) * 60 * 60 * 1000;
          scheduleThreadInactivityCheck(threadId);
        }
      }
    } catch (err) {
      console.error(`Error checking or deleting thread ${threadId}:`, err);
    }
  }, 24 * 60 * 60 * 1000);
}

async function checkAllQuizThreadsForInactivity() {
  try {
    const quizChannels = await Promise.all(
      Array.from(serverConfig).map(async ([serverId, config]) => {
        const server = await client.guilds.fetch(serverId);
        return await server.channels.fetch(config.quizId);
      })
    );

    quizChannels.forEach(async (quizChannel) => {
      const threads = await quizChannel.threads.fetchActive();
      threads.threads.forEach(async (thread) => {
        try {
          if (thread.isThread() && !thread.archived) {
            const lastMessage = await thread.messages.fetch({ limit: 1 });
            const lastActivity = lastMessage.first()?.createdTimestamp || thread.createdTimestamp;
            const now = Date.now();
            const hoursInactive = (now - lastActivity) / (1000 * 60 * 60);

            if (hoursInactive >= 24) {
              await thread.delete(`Thread inactive for over 24h`);
              console.log(`Deleted inactive thread: ${thread.name}`);
            } else {
              scheduleThreadInactivityCheck(thread.id);
            }
          }
        } catch (err) {
          console.error(`Error checking thread ${thread.id}:`, err);
        }
      });

      const archivedThreads = await quizChannel.threads.fetchArchived();

      archivedThreads.threads.forEach(async (thread) => {
        try {
          const lastMessage = await thread.messages.fetch({ limit: 1 });
          const lastActivity = lastMessage.first()?.createdTimestamp || thread.createdTimestamp;
          const now = Date.now();
          const hoursInactive = (now - lastActivity) / (1000 * 60 * 60);

          if (hoursInactive >= 24) {
            await thread.delete(`Thread inactive for over 24h`);
            console.log(`Deleted inactive thread: ${thread.name}`);
          }
        } catch (err) {
          console.error(`Error checking archived thread ${thread.id}:`, err);
        }
      });
    });
  } catch (error) {
    console.error('Error checking all quiz threads:', error);
  }
}

async function showLeaderboard(channel, inputName) {
  const mapNames = mapNames;

  const normalizedInput = inputName?.toLowerCase();

  let mapName = mapAliases[normalizedInput] || inputName;

  if (!mapName || !mapNames.includes(mapName)) {
    const similarMap = mapNames.find(m => m.toLowerCase() === normalizedInput);
    if (similarMap) {
      mapName = similarMap;
    } else {
      await channel.send(`Map "${inputName}" not found. Available maps: ${mapNames.join(', ')}`);
      return;
    }
  }

  const mapLeaderboard = leaderboardStreaks[mapName] || [];

  if (mapLeaderboard.length === 0) {
    await channel.send(`No leaderboard data for map "${mapName}" yet. Be the first to set a record!`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${mapName} - Leaderboard`)
    .setColor('#f1c40f')
    .setFooter({ text: `Updated: ${getDay()}` });

  const topPlayers = mapLeaderboard.slice(0, 10);

  let description = '';
  topPlayers.forEach((entry, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
    const time = formatTime(entry.averageTime);
    description += `${medal} **${entry.username}** - Streak: ${entry.streak} | Average Time: ${time} | Date: ${getDay(entry.lastUpdate)}\n`;
  });

  embed.setDescription(description);
  await channel.send({ embeds: [embed] });
}



async function showPersonalStats(message) {
  let userId = message.author.id;
  let username = message.author.username;
  let targetUser = message.author;

  const content = message.content.trim();
  if (content.startsWith('!stats ')) {
    const mentionOrName = content.substring('!stats '.length).trim();

    if (message.mentions.users.size > 0) {
      targetUser = message.mentions.users.first();
      userId = targetUser.id;
      username = targetUser.username;
    }
    else if (mentionOrName) {
      let found = false;

      for (const [id, maps] of Object.entries(personalBestStreaks)) {
        for (const mapData of Object.values(maps)) {
          if (mapData.username && mapData.username.toLowerCase() === mentionOrName.toLowerCase()) {
            userId = id;
            username = mapData.username;
            const user = client.users.cache.get(id);
            if (user) {
              targetUser = user;
            }
            found = true;
            break;
          }
        }

        if (found) break;
      }

      if (!found) {
        return message.reply(`User "${mentionOrName}" not found in stats database`);
      }
    }
  }

  const userStats = personalBestStreaks[userId] || {};

  if (Object.keys(userStats).length === 0) {
    return message.reply(`${username} doesn't have streak yet (noob)`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📊 Stats for ${username}`)
    .setColor('#9b59b6');

  let description = '';
  for (const [mapName, stats] of Object.entries(userStats)) {
    const formattedTime = formatTime(stats.totalTime);

    let position = 'not ranked';
    if (leaderboardStreaks[mapName]) {
      const userPos = leaderboardStreaks[mapName].findIndex(entry => entry.userId === userId);
      if (userPos >= 0) {
        position = `#${userPos + 1}`;
      }
    }

    description += `**${mapName}**\n`;
    description += `Best Streak: ${stats.streak} | Time: ${formattedTime} | Rank: ${position} | Date: ${getDay(stats.lastUpdate)}\n\n`;
  }

  embed.setDescription(description);
  await message.reply({ embeds: [embed] });
}


client.on('interactionCreate', async (interaction) => {
  console.log('Interaction received:', interaction.type, interaction.customId ?? 'no customId');

  if (interaction.isButton() && interaction.customId === 'create_private_thread') {
    console.log('Button clicked:', interaction.customId);
    await createPrivateThread(interaction, interaction.user.id);
  }

  const guild = interaction.guild;
  switch (interaction.commandName) {
    case 'setup':
      const createQuizId = interaction.options.getChannel('create_quiz_channel').id;
      const quizId = interaction.options.getChannel('quiz_channel').id;
      const adminId = interaction.options.getChannel('admin_channel').id;

      serverConfig[guild] = { createQuizId, quizId, adminId };
      saveJsonFile(SERVER_CONFIG_PATH, serverConfig);

      await interaction.reply({ content: `Finished setting up StreakBot!`, ephemeral: true});
      break;

    case 'create_channels':
      // Create StreakBot category
      const category = await guild.channels.create({
        name: 'StreakBot',
        type: ChannelType.GuildCategory,
      });

      // Create channels under category
      const channels = ['create-quiz', 'streakbot', 'bot-admin'];
      for (const channel of channels) {
        await guild.channels.create({
          name: channel,
          type: ChannelType.GuildText,
          parent: category.id,
        });
      }

      await interaction.reply({ content: `Finished setting up channels!`, ephemeral: true});
      break;

    case 'add_map':
      if (interaction.channel.id !== getAdminId(interaction)) {
        await interaction.reply({ content: 'This command can only be used within the admin channel.'});
        return;
      }

      const addName = interaction.options.getString('name');
      const aliases = interaction.options.getString('aliases').split(',').map(item => item.trim());
      const distribution = interaction.options.getAttachment('distribution');

      if (distribution) {
        const imagePath = path.join(__dirname, 'assets', distribution.name);
        mapData[addName] = { aliases: aliases, distribution: distribution.name };
        await distribution.save(imagePath);
      } else {
        mapData[addName] = { aliases: aliases };
      }

      saveJsonFile(path.join(__dirname, 'constants/maps_data.json'), mapData);
      refreshMaps();

      await interaction.reply({ content: `Finished adding map "${addName}"!`});
      break;

    case 'delete_map':
      if (interaction.channel.id !== getAdminId(interaction)) {
        await interaction.reply({ content: 'This command can only be used within the admin channel.'});
        return;
      }

      const deleteName = mapAliases[interaction.options.getString('name')];
      if (!(deleteName in mapData)) {
        interaction.reply(`No map found named "${deleteName}"`);
        return;
      }
      delete mapData[deleteName];
      saveJsonFile(path.join(__dirname, 'constants/maps_data.json'), mapData);
      refreshMaps();

      await interaction.reply({ content: `Finished deleting map "${deleteName}"!`});
      break;
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  initializeThreadCleanup();
  try {
    await initializeResources();
  } catch (error) {
    console.error("Erreur lors de l'initialisation des ressources:", error);
  }

});

async function sendPrivateMessageOffer(createQuizId) {
  try {
    const channel = await client.channels.fetch(createQuizId);
    if (!channel) {
      console.error('Quiz channel not found');
      return;
    }

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('create_private_thread')
          .setLabel('Create Private Quiz Thread')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎮')
      );

    const embed = new EmbedBuilder()
      .setTitle('🌍 Start Your Private Session')
      .setDescription(
        '**Play uninterrupted, at your own pace.**\nCreate a private thread just for you — perfect for solo challenges or games with friends.'
      )
      .addFields(
        {
          name: '👥 Multiplayer Control',
          value: 'Use `!invite @<user>` to invite friends, and `!kick @<user>` to remove them from your thread.'
        }
      )
      .setColor('#3498db')
      .setFooter({ text: 'Private threads auto-clean after inactivity.' });

    await channel.send({
      embeds: [embed],
      components: [row]
    });


    console.log('Private thread creation message sent');
  } catch (error) {
    console.error('Error sending private message offer:', error);
  }
}

// Handles all commands of players
async function handlePlayerCommands(message) {
  const content = message.content.trim().toLowerCase();
  const [command, ...args] = content.split(' ');
  const quizId = getQuizId(message);
  let mentionedUser;
  switch (command) {
    case '!invite':
      if (message.mentions.users.size === 0) return;
      mentionedUser = message.mentions.users.first();

      if (!message.channel.isThread()) {
        await message.reply('❌ This command can only be used inside a thread.');
        return;
      }

      try {
        await message.channel.members.add(mentionedUser.id);
        await message.reply(`✅ Successfully invited ${mentionedUser.username} to the thread.`);
      } catch (error) {
        console.error('Error inviting user:', error);
        await message.reply('❌ Failed to invite the user. Make sure I have the correct permissions.');
      }
      break;

    case '!kick':
      if (message.mentions.users.size === 0) return;

      mentionedUser = message.mentions.users.first();

      if (!message.channel.isThread()) {
        await message.reply('❌ This command can only be used inside a thread.');
        return;
      }

      try {
        await message.channel.members.remove(mentionedUser.id);
        await message.reply(`✅ Successfully kicked ${mentionedUser.username} from the thread.`);
      } catch (error) {
        console.error('Error kicking user:', error);
        await message.reply('❌ Failed to kick the user. Make sure I have the correct permissions.');
      }
      break;
      
    case '!stop':
      const channelId = message.channel.id;
      const quiz = quizzesByChannel[channelId];

      if (!quiz || quiz.solved) {
        return message.reply("❌ There's no ongoing game to stop in this channel.");
      }

      quiz.solved = true;

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🛑 Game Stopped')
            .setDescription(`The current game has been stopped manually.`)
            .addFields(
              { name: 'Final Streak', value: `${quiz.currentStreak}`, inline: true },
              {
                name: "Exact Location",
                value: `[View on Street View](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${quiz.location.lat},${quiz.location.lng}&heading=0&pitch=0)`
              }
            )
            .setColor('#f39c12')
        ]
      });

      delete quizzesByChannel[channelId];
      break;
    
    case '!g':
      await handleGuess(message, args.join(' '));
      break;
    
    case '!play':
      if (quizzesByChannel[message.channel.id] && !quizzesByChannel[message.channel.id].solved) {
        await message.reply("There's already an active quiz. Solve it first or wait for it to complete!");
        return;
      }
      const mapName = args.length > 0 ? args.join(' ') : null;

      if (mapName) {
        const matchedMapName = Object.keys(maps).find(
          key => key.toLowerCase() === mapName.toLowerCase()
        );

        await newLoc(message.channel, quizId, matchedMapName || mapName, message.author.id);
      } else {
        await newLoc(message.channel, quizId, null, message.author.id);
      }
      break;
    
    case '!maps':
      const mapNames = Object.keys(maps);
      const mapsEmbed = new EmbedBuilder()
        .setTitle('Available Maps')
        .setDescription(mapNames.join('\n'))
        .setColor('#3498db');

      await message.channel.send({ embeds: [mapsEmbed] });
      break;
    
    case '!help':
      const helpEmbed = new EmbedBuilder()
        .setTitle('Bot Commands')
        .setDescription('Here are the available commands:')
        .addFields(
          { name: '!help', value: 'Show the help message' },
          { name: '!play', value: 'Start a new quiz with a random map' },
          { name: '!play <map>', value: 'Start a new quiz with the specified map' },
          { name: '!g <country>', value: 'Submit your guess for the current quiz' },
          { name: '!maps', value: 'Show all available maps' },
          { name: '!stats', value: 'Show your personal stats and records' },
          { name: '!leaderboard <map>', value: 'Show the leaderboard for a specific map' },
          { name: '!invite @<user>', value: 'Invite a user to your private thread *(only works in threads)*' },
          { name: '!kick @<user>', value: 'Kick a user from your private thread *(only works in threads)*' }
        )
        .setColor('#3498db');
      await message.channel.send({ embeds: [helpEmbed] });
      break;
    
    case '!stats':
      await showPersonalStats(message);
      break;
    
    case '!leaderboard':
      const input = args.join(' ').toLowerCase();
      const resolvedMapName = mapAliases[input];

      if (!resolvedMapName) {
        return message.reply({
          content: `Unknown map: \`${input}\`. Try one of: ${mapNames.join(', ')}`,
          ephemeral: true
        });
      }

      await showLeaderboard(message.channel, resolvedMapName);
      break;
    
    case '!map', '!locs', '!locations', '!distribution':
      const mapImage = mapImages[args.join(' ')];

      if (!mapImage) {
        return message.reply("❌ Unknown map. Try `abe`, `abaf`, or full names like `a balanced europe`.");
      }

      const imagePath = path.join(__dirname, "assets", mapImage);

      if (!fs.existsSync(imagePath)) {
        return message.reply("❌ Image file not found.");
      }

      const file = new AttachmentBuilder(imagePath);
      const embed = new EmbedBuilder()
        .setTitle(`${mapAliases[key]} - Distribution`)
        .setImage(`attachment://${mapImage}`)
        .setColor(0x2ecc71);

      await message.channel.send({ embeds: [embed], files: [file] });
      break;
  }
}

// Handles all comands of admins
async function handleAdminCommands(message) {
  const content = message.content.trim().toLowerCase();
  const [command, ...args] = content.split(' ');
  const createQuizId = getCreateQuizId(message);
  switch (command) {
    case '!private_msg':
      await sendPrivateMessageOffer(createQuizId);
      await message.reply('Private thread creation message sent to the quiz channel!');
      break;

    case '!help_admin':
      const helpEmbed = new EmbedBuilder()
        .setTitle("Administrator bot commands")
        .setDescription("Here are all the available admin commands")
        .addFields(
          { name: '!help_admin', value: 'Show the admin help message' },
          { name: '!private_msg', value: "Create an announcement message to create private quizzes" }
        )
        .setColor('#3498db');
      await message.channel.send({ embeds: [helpEmbed] });
      break;
  }
}

// Listens to any potential command
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (message.channel.id === getAdminId(message)) handleAdminCommands(message);
  else if (isQuizChannel(message.channel, getQuizId(message))) handlePlayerCommands(message);
});

function initializeThreadCleanup() {
  checkAllQuizThreadsForInactivity();
  setInterval(() => {
    checkAllQuizThreadsForInactivity();
  }, 6 * 60 * 60 * 1000);
}

client.login(BOT_TOKEN);
// by @flykii on discord