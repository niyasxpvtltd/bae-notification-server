const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ============================================================
// FIREBASE ADMIN SDK INITIALIZATION
// ============================================================
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

let db = null;
let messaging = null;
let firebaseInitialized = false;

try {
  let credential = null;
  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

  const getCert = (sa) => {
    if (admin.credential && typeof admin.credential.cert === 'function') {
      return admin.credential.cert(sa);
    }
    if (typeof admin.cert === 'function') {
      return admin.cert(sa);
    }
    throw new Error('Neither admin.credential.cert nor admin.cert is available');
  };

  // Option 1: Base64 string in env (ideal for Render to avoid multiline JSON issues)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
    credential = getCert(JSON.parse(decoded));
  }
  // Option 2: Raw JSON string in env
  else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const parsed = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : process.env.FIREBASE_SERVICE_ACCOUNT;
    credential = getCert(parsed);
  }
  // Option 3: Local file
  else if (fs.existsSync(serviceAccountPath)) {
    credential = getCert(require(serviceAccountPath));
  }

  if (credential) {
    const fbApp = admin.initializeApp({ credential });
    db = getFirestore(fbApp);
    messaging = getMessaging(fbApp);
    firebaseInitialized = true;
    console.log('✅ [FIREBASE_ADMIN] Initialized successfully for project: bae-project-e5bc1');
  } else {
    console.warn('⚠️ [FIREBASE_ADMIN] No credentials found. Notifications running in mock mode.');
  }
} catch (fbErr) {
  console.error('❌ [FIREBASE_ADMIN_INIT_ERROR]', fbErr.message);
}

// Health checks
app.get('/', (req, res) => {
  res.json({
    service: 'BAE Connect Notification Service',
    status: 'online',
    firebase: firebaseInitialized ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  });
});

app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ============================================================
// AUTOMATED PUSH NOTIFICATIONS
// 1. Male Online -> Notify Last 30 Active Offline Females (Per-user cooldown, includes male name)
// 2. Female Online -> Notify Offline Males (15-min cooldown, includes female name)
// ============================================================
const maleUserLastTrigger = new Map();
const PER_MALE_COOLDOWN_MS = 5 * 60 * 1000; // 5 mins per individual male user

let lastMaleNotificationTime = 0;
const MALE_NOTIF_COOLDOWN_MS = 15 * 60 * 1000; // 15 mins cooldown for male notifications

app.get('/api/notifications/status', (req, res) => {
  const now = Date.now();
  const maleElapsedMs = now - lastMaleNotificationTime;
  const maleCooldownRemainingMs = Math.max(0, MALE_NOTIF_COOLDOWN_MS - maleElapsedMs);
  return res.json({
    service: 'bae-notification-server',
    firebaseInitialized,
    maleTargetCooldownRemainingMinutes: Math.ceil(maleCooldownRemainingMs / 60000),
    isMaleCooldownActive: maleCooldownRemainingMs > 0,
    lastSentToMalesTimestamp: lastMaleNotificationTime ? new Date(lastMaleNotificationTime).toISOString() : null,
    activeMaleTriggersTracked: maleUserLastTrigger.size,
  });
});

// 1. MALE USER ONLINE -> Notify Offline Top 30 Active Females with Male Name
app.post('/api/notifications/male-online', async (req, res) => {
  try {
    const { maleUid, maleName, force } = req.body || {};
    const now = Date.now();
    const cleanMaleName = (maleName && maleName.trim()) ? maleName.trim() : 'Someone';

    console.log(`[PUSH_TRIGGER_MALE] Male online: ${cleanMaleName} (${maleUid || 'unknown'})`);

    // Individual male cooldown check: don't let same user spam if they toggle 10 times
    if (!force && maleUid && maleUserLastTrigger.has(maleUid)) {
      const lastTrigger = maleUserLastTrigger.get(maleUid);
      if (now - lastTrigger < PER_MALE_COOLDOWN_MS) {
        const remainingMin = Math.ceil((PER_MALE_COOLDOWN_MS - (now - lastTrigger)) / 60000);
        console.log(`[PUSH_MALE_SKIP] User ${maleUid} triggered recently. Next in ${remainingMin}m.`);
        return res.json({
          skipped: true,
          reason: 'USER_COOLDOWN_ACTIVE',
          message: `${cleanMaleName} already triggered a notification recently.`,
        });
      }
    }

    if (!firebaseInitialized || !db || !messaging) {
      console.warn('[PUSH_WARN] Firebase Admin not initialized. Skipping push.');
      return res.status(503).json({ success: false, error: 'Firebase Admin not initialized' });
    }

    // Query female users (supports both 'Female' and 'female')
    const snapshot = await db.collection('users')
      .where('gender', 'in', ['Female', 'female', 'FEMALE'])
      .limit(100)
      .get();

    if (snapshot.empty) {
      console.log('[PUSH_INFO] No female users found in database.');
      return res.json({ success: true, count: 0, message: 'No female users found' });
    }

    // Filter offline female users & sort by last_seen
    const femaleUsers = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Skip users who are ALREADY ONLINE or IN A CALL
      if (data.is_online === true || data.call_state === 'in_call' || data.call_state === 'busy') {
        return;
      }
      femaleUsers.push({
        id: doc.id,
        fcm_token: data.fcm_token,
        last_seen: data.last_seen || data.updated_at || '',
      });
    });

    femaleUsers.sort((a, b) => {
      const timeA = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      const timeB = b.last_seen ? new Date(b.last_seen).getTime() : 0;
      return timeB - timeA;
    });

    // Take top 30 most recently active offline female users
    const top30Females = femaleUsers.slice(0, 30);
    const validTokens = top30Females
      .map(u => u.fcm_token)
      .filter(token => typeof token === 'string' && token.trim().length > 10);

    const notificationPayload = {
      title: '🔔 Bae - Boys are Online! 🔥',
      body: `Active users are looking for video calls right now! Go online to earn cash 💰\n${cleanMaleName} is online`,
    };

    let sentCount = 0;
    if (validTokens.length > 0) {
      const response = await messaging.sendEachForMulticast({
        tokens: validTokens,
        notification: notificationPayload,
        android: {
          priority: 'high',
          notification: {
            channelId: 'bae_notifications',
            sound: 'default',
          },
        },
      });
      sentCount = response.successCount;
      console.log(`[PUSH_SUCCESS_MALE_ONLINE] Sent to ${response.successCount} of ${validTokens.length} active female tokens for ${cleanMaleName}`);
    } else {
      console.log('[PUSH_FALLBACK] No direct tokens. Broadcasting to topic "female_users"...');
      await messaging.send({
        topic: 'female_users',
        notification: notificationPayload,
        android: {
          priority: 'high',
          notification: {
            channelId: 'bae_notifications',
            sound: 'default',
          },
        },
      });
      sentCount = 1;
    }

    if (maleUid) {
      maleUserLastTrigger.set(maleUid, now);
    }

    return res.json({
      success: true,
      sentCount,
      targetedEligibleFemales: top30Females.length,
      userNotified: cleanMaleName,
      mode: validTokens.length > 0 ? 'direct_token_multicast' : 'topic_female_users',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[PUSH_MALE_ONLINE_ERROR]', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 2. FEMALE USER ONLINE -> Notify Offline Male Users with Female Name (With 15 min Cooldown)
app.post('/api/notifications/female-online', async (req, res) => {
  try {
    const { femaleUid, femaleName, force } = req.body || {};
    const now = Date.now();
    const cleanFemaleName = (femaleName && femaleName.trim()) ? femaleName.trim() : 'Someone';

    console.log(`[PUSH_TRIGGER_FEMALE] Female online: ${cleanFemaleName} (${femaleUid || 'unknown'})`);

    // Cooldown check for males (15 minutes)
    if (!force && lastMaleNotificationTime && (now - lastMaleNotificationTime < MALE_NOTIF_COOLDOWN_MS)) {
      const waitMinutes = Math.ceil((MALE_NOTIF_COOLDOWN_MS - (now - lastMaleNotificationTime)) / 60000);
      console.log(`[PUSH_COOLDOWN_MALES] Cooldown active. Skipping notification (${waitMinutes}m remaining).`);
      return res.json({
        skipped: true,
        reason: 'COOLDOWN_ACTIVE',
        message: `Cooldown active for males. Next notification available in ${waitMinutes} minute(s).`,
      });
    }

    if (!firebaseInitialized || !db || !messaging) {
      console.warn('[PUSH_WARN] Firebase Admin not initialized. Skipping push.');
      return res.status(503).json({ success: false, error: 'Firebase Admin not initialized' });
    }

    // Query male users (supports both 'Male' and 'male')
    const snapshot = await db.collection('users')
      .where('gender', 'in', ['Male', 'male', 'MALE'])
      .limit(100)
      .get();

    if (snapshot.empty) {
      console.log('[PUSH_INFO] No male users found in database.');
      return res.json({ success: true, count: 0, message: 'No male users found' });
    }

    // Filter offline male users & sort by last_seen
    const maleUsers = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Skip users who are ALREADY ONLINE or IN A CALL
      if (data.is_online === true || data.call_state === 'in_call' || data.call_state === 'busy') {
        return;
      }
      maleUsers.push({
        id: doc.id,
        fcm_token: data.fcm_token,
        last_seen: data.last_seen || data.updated_at || '',
      });
    });

    maleUsers.sort((a, b) => {
      const timeA = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      const timeB = b.last_seen ? new Date(b.last_seen).getTime() : 0;
      return timeB - timeA;
    });

    // Take top 50 active offline males
    const topMales = maleUsers.slice(0, 50);
    const validTokens = topMales
      .map(u => u.fcm_token)
      .filter(token => typeof token === 'string' && token.trim().length > 10);

    const notificationPayload = {
      title: '🔔 Bae - Girls are Online! 💖',
      body: `Call now and talk with your nearby Bae! 💖\n${cleanFemaleName} is online`,
    };

    let sentCount = 0;
    if (validTokens.length > 0) {
      const response = await messaging.sendEachForMulticast({
        tokens: validTokens,
        notification: notificationPayload,
        android: {
          priority: 'high',
          notification: {
            channelId: 'bae_notifications',
            sound: 'default',
          },
        },
      });
      sentCount = response.successCount;
      console.log(`[PUSH_SUCCESS_FEMALE_ONLINE] Sent to ${response.successCount} of ${validTokens.length} male tokens for ${cleanFemaleName}`);
    } else {
      console.log('[PUSH_FALLBACK] Broadcasting to topic "male_users"...');
      await messaging.send({
        topic: 'male_users',
        notification: notificationPayload,
        android: {
          priority: 'high',
          notification: {
            channelId: 'bae_notifications',
            sound: 'default',
          },
        },
      });
      sentCount = 1;
    }

    lastMaleNotificationTime = now;
    return res.json({
      success: true,
      sentCount,
      targetedEligibleMales: topMales.length,
      girlNotified: cleanFemaleName,
      mode: validTokens.length > 0 ? 'direct_token_multicast' : 'topic_male_users',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[PUSH_FEMALE_ONLINE_ERROR]', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`🚀 BAE Push Notification Server running on port ${PORT}`);
  console.log(`   Firebase: ${firebaseInitialized ? 'Connected ✅' : 'Mock Mode ⚠️'}`);
  console.log(`=================================================`);
});


