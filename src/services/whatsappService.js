// services/whatsappService.js
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const AutoReplyService = require('./autoReplyService');
const autoReply = new AutoReplyService();

const logger = P({ level: 'silent' });

class WhatsAppService {
    constructor(io) {
        this.io = io;
        this.sessions = new Map();
        this.qrBuffer = new Map();
        this.laravelUrl = process.env.LARAVEL_URL || 'http://localhost:8000';
        this.lidMap = new Map(); // Store phone → LID mapping
        this.messageStatusMap = new Map(); // Track message IDs for delivery/read status
    }

    getAuthFolder(businessId) {
        const folder = path.join(process.cwd(), 'auth', `business_${businessId}`);
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        return folder;
    }

    async notifyLaravel(event, businessId, data = {}) {
        try {
            const url = `${this.laravelUrl}/api/whatsapp/webhook`;
            console.log(`[${businessId}] 📤 Notifying Laravel: ${event}`);

            await axios.post(url, {
                event,
                business_id: businessId,
                data
            }, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (err) {
            console.error(`[${businessId}] ❌ Laravel webhook failed:`, err.message);
        }
    }

    async connect(businessId) {
        businessId = String(businessId);
        console.log(`\n[${businessId}] 🚀 Starting WhatsApp connection...`);

        // Cleanup existing session
        const existing = this.sessions.get(businessId);
        if (existing?.socket) {
            try {
                existing.socket.ev.removeAllListeners();
                await existing.socket.end();
            } catch(e) {}
            this.sessions.delete(businessId);
        }

        this.qrBuffer.delete(businessId);

        const authFolder = this.getAuthFolder(businessId);
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: state,
            browser: ['Chrome (Linux)', '', ''],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 30000,
        });

        this.sessions.set(businessId, {
            socket: sock,
            status: 'connecting',
            qr: null,
            phoneNumber: null,
        });

        // ========== CONNECTION UPDATES ==========
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = this.sessions.get(businessId);
            if (!session) return;

            if (qr) {
                try {
                    const qrImage = await QRCode.toDataURL(qr, {
                        type: 'image/png',
                        margin: 2,
                        width: 400
                    });

                    session.qr = qrImage;
                    session.status = 'qr_pending';

                    const emitData = {
                        business_id: businessId,
                        qr: qrImage,
                        status: 'qr_pending',
                        message: 'Scan QR code with WhatsApp'
                    };

                    this.qrBuffer.set(businessId, emitData);
                    this.io.to(`business-${businessId}`).emit('whatsapp-qr', emitData);
                    await this.notifyLaravel('qr_generated', businessId, { qr: qrImage });

                } catch (err) {
                    console.error(`[${businessId}] QR error:`, err);
                }
            }

            if (connection === 'open') {
                console.log(`[${businessId}] ✅ CONNECTED!`);
                session.status = 'connected';
                this.qrBuffer.delete(businessId);

                let phoneNumber = null;
                try {
                    if (sock.user?.id) {
                        phoneNumber = sock.user.id.split(':')[0].split('@')[0];
                    }
                } catch (err) {}

                session.phoneNumber = phoneNumber;
                await this.notifyLaravel('connected', businessId, { phone_number: phoneNumber });

                this.io.to(`business-${businessId}`).emit('whatsapp-status', {
                    business_id: businessId,
                    status: 'connected',
                    phone_number: phoneNumber,
                    message: phoneNumber ? `Connected: ${phoneNumber}` : 'Connected'
                });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason.restartRequired;
                session.status = 'disconnected';

                await this.notifyLaravel('disconnected', businessId);
                this.io.to(`business-${businessId}`).emit('whatsapp-status', {
                    business_id: businessId,
                    status: shouldReconnect ? 'connecting' : 'disconnected',
                    message: shouldReconnect ? 'Restarting...' : 'Disconnected'
                });

                if (shouldReconnect) {
                    this.sessions.delete(businessId);
                    setTimeout(() => this.connect(businessId), 3000);
                } else {
                    this.sessions.delete(businessId);
                    this.qrBuffer.delete(businessId);
                }
            }
        });

        // ========== CREDENTIALS UPDATE ==========
        sock.ev.on('creds.update', saveCreds);

        // ========== MESSAGE STATUS UPDATES (Delivered/Read) ==========
        sock.ev.on('messages.update', async (updates) => {
            console.log(`\n[${businessId}] 📊 ========== MESSAGE STATUS UPDATE ==========`);

            for (const update of updates) {
                const { key, update: statusUpdate } = update;
                const waMessageId = key?.id;

                if (!waMessageId) continue;

                console.log(`[${businessId}] Status update for: ${waMessageId}`, statusUpdate);

                // Check if this is our tracked broadcast message
                const mapping = this.messageStatusMap.get(waMessageId);
                if (!mapping) {
                    console.log(`[${businessId}] ℹ️ Not a tracked broadcast message`);
                    continue;
                }

                const { campaignId, recipientId } = mapping;

                // Baileys status codes: 1=PENDING, 2=SENT, 3=DELIVERED, 4=READ, 5=PLAYED
                if (statusUpdate?.status === 3) { // DELIVERED
                    console.log(`[${businessId}] ✅ Message DELIVERED: ${waMessageId}`);
                    await this.notifyLaravel('message_status', businessId, {
                        wa_message_id: waMessageId,
                        status: 'delivered',
                        campaign_id: campaignId,
                        recipient_id: recipientId
                    });
                } else if (statusUpdate?.status === 4) { // READ
                    console.log(`[${businessId}] 👁️ Message READ: ${waMessageId}`);
                    await this.notifyLaravel('message_status', businessId, {
                        wa_message_id: waMessageId,
                        status: 'read',
                        campaign_id: campaignId,
                        recipient_id: recipientId
                    });
                }
            }

            console.log(`[${businessId}] 📊 ========== STATUS UPDATE END ==========\n`);
        });

        // ========== MESSAGES HANDLER ==========
        sock.ev.on('messages.upsert', async (messageData) => {
            console.log(`\n[${businessId}] 📩 ========== NEW MESSAGE ==========`);
            console.log(`[${businessId}] Type: ${messageData.type}`);
            console.log(`[${businessId}] Messages count: ${messageData.messages?.length}`);

            const message = messageData.messages[0];

            if (!message) {
                console.log(`[${businessId}] ⚠️ No message object`);
                return;
            }

            // Check if message has content
            if (!message.message) {
                console.log(`[${businessId}] ⚠️ No message content`);
                return;
            }

            // Check fromMe
            console.log(`[${businessId}] Message key:`, JSON.stringify(message.key));
            console.log(`[${businessId}] From me: ${message.key?.fromMe}`);

            if (message.key?.fromMe === true) {
                console.log(`[${businessId}] ℹ️ Skipping own message`);
                return;
            }

            const from = message.key?.remoteJid;

            if (!from) {
                console.log(`[${businessId}] ⚠️ No remote JID`);
                return;
            }

            // Skip status broadcasts
            if (from === 'status@broadcast') {
                console.log(`[${businessId}] ⚠️ Skipping status broadcast`);
                return;
            }

            // Extract text
            let text = '';
            if (message.message.conversation) {
                text = message.message.conversation;
                console.log(`[${businessId}] Type: conversation`);
            } else if (message.message.extendedTextMessage?.text) {
                text = message.message.extendedTextMessage.text;
                console.log(`[${businessId}] Type: extendedTextMessage`);
            } else if (message.message.imageMessage?.caption) {
                text = message.message.imageMessage.caption;
                console.log(`[${businessId}] Type: imageMessage with caption`);
            }

            console.log(`[${businessId}] From: ${from}`);
            console.log(`[${businessId}] Text: "${text}"`);

            if (!text || text.trim() === '') {
                console.log(`[${businessId}] ⚠️ Empty text`);
                return;
            }

            // Extract phone number
            let customerPhone = from;
            if (from.includes('@s.whatsapp.net')) {
                customerPhone = from.replace('@s.whatsapp.net', '');
            } else if (from.includes('@lid')) {
                customerPhone = from.replace('@lid', '');
                console.log(`[${businessId}] ℹ️ LID format detected`);
            } else if (from.includes('@c.us')) {
                customerPhone = from.replace('@c.us', '');
            }

            console.log(`[${businessId}] Phone: ${customerPhone}`);

            // STORE LID MAPPING
            if (from.includes('@lid')) {
                this.lidMap.set(customerPhone, from);
                console.log(`[${businessId}] 💾 Stored LID: ${customerPhone} → ${from}`);
            }

            const msgData = {
                id: message.key.id,
                from: customerPhone,
                text: text,
                timestamp: new Date().toISOString()
            };

            // Emit to frontend
            this.io.to(`business-${businessId}`).emit('whatsapp-message', {
                business_id: businessId,
                ...msgData,
                direction: 'incoming'
            });

            // AUTO-REPLY
            console.log(`[${businessId}] 🤖 Checking auto-reply...`);

            try {
                const autoReplyResult = await autoReply.processIncomingMessage(
                    businessId, 
                    customerPhone, 
                    text
                );

                if (autoReplyResult && autoReplyResult.shouldReply) {
                    console.log(`[${businessId}] ✅ Auto-reply matched! Sending...`);

                    await this.sendMessage(
                        businessId,
                        customerPhone,
                        autoReplyResult.content.text
                    );

                    console.log(`[${businessId}] ✅ Auto-reply sent!`);

                    await autoReply.trackUsage(autoReplyResult.template.id);

                    this.io.to(`business-${businessId}`).emit('auto-reply-triggered', {
                        business_id: businessId,
                        template_name: autoReplyResult.template.name,
                        customer_phone: customerPhone,
                        message: autoReplyResult.content.text
                    });
                } else {
                    console.log(`[${businessId}] ℹ️ No auto-reply matched`);
                }
            } catch (err) {
                console.error(`[${businessId}] ❌ Auto-reply error:`, err.message);
            }

            // Notify Laravel (with broadcast reply tracking)
            await this.notifyLaravel('message_received', businessId, {
                ...msgData,
                is_reply_check: true  // Flag to check for broadcast reply
            });

            console.log(`[${businessId}] 📩 ========== MESSAGE END ==========\n`);
        });

        return { status: 'connecting' };
    }

    // ========== SEND MESSAGE (WITH LID FIX + STATUS TRACKING) ==========
    async sendMessage(businessId, to, message, campaignId = null, recipientId = null) {
        businessId = String(businessId);

        const session = this.sessions.get(businessId);
        if (!session) throw new Error('Session not found');
        if (session.status !== 'connected') throw new Error('Not connected');

        // LID FIX: Check if we have stored LID for this phone
        const storedLid = this.lidMap.get(to);

        let jid;
        if (storedLid) {
            jid = storedLid;
            console.log(`[${businessId}] 📤 Using STORED LID: ${jid}`);
        } else if (to.includes('@')) {
            jid = to;
            console.log(`[${businessId}] 📤 Using provided JID: ${jid}`);
        } else {
            jid = `${to}@s.whatsapp.net`;
            console.log(`[${businessId}] 📤 Using normal JID: ${jid}`);
        }

        console.log(`[${businessId}] 📤 Sending message to: ${jid}`);
        console.log(`[${businessId}] Message: "${message}"`);

        try {
            const result = await session.socket.sendMessage(jid, { text: message });
            console.log(`[${businessId}] ✅ Sent! ID: ${result.key.id}`);

            // STORE MESSAGE ID FOR STATUS TRACKING
            if (result?.key?.id && campaignId && recipientId) {
                this.messageStatusMap.set(result.key.id, {
                    campaignId,
                    recipientId,
                    timestamp: Date.now()
                });

                console.log(`[${businessId}] 💾 Tracked message: ${result.key.id} -> Campaign:${campaignId}, Recipient:${recipientId}`);

                // Cleanup after 24 hours
                setTimeout(() => {
                    this.messageStatusMap.delete(result.key.id);
                }, 24 * 60 * 60 * 1000);
            }

            return { success: true, messageId: result.key.id };

        } catch (error) {
            console.error(`[${businessId}] ❌ Send failed:`, error.message);

            // Fallback: Try normal JID if LID fails
            if (storedLid && !jid.includes('@s.whatsapp.net')) {
                const fallbackJid = `${to}@s.whatsapp.net`;
                console.log(`[${businessId}] 🔄 Trying fallback JID: ${fallbackJid}`);
                try {
                    const fallbackResult = await session.socket.sendMessage(fallbackJid, { text: message });
                    console.log(`[${businessId}] ✅ Fallback sent! ID: ${fallbackResult.key.id}`);

                    // Track fallback message too
                    if (fallbackResult?.key?.id && campaignId && recipientId) {
                        this.messageStatusMap.set(fallbackResult.key.id, {
                            campaignId,
                            recipientId,
                            timestamp: Date.now()
                        });
                        setTimeout(() => {
                            this.messageStatusMap.delete(fallbackResult.key.id);
                        }, 24 * 60 * 60 * 1000);
                    }

                    return { success: true, messageId: fallbackResult.key.id };
                } catch (fallbackError) {
                    console.error(`[${businessId}] ❌ Fallback also failed:`, fallbackError.message);
                }
            }

            throw error;
        }
    }

    getStatus(businessId) {
        businessId = String(businessId);
        const session = this.sessions.get(businessId);

        if (!session) {
            const authFolder = path.join(process.cwd(), 'auth', `business_${businessId}`);
            const wasConnected = fs.existsSync(path.join(authFolder, 'creds.json'));

            return {
                connected: false,
                status: wasConnected ? 'disconnected' : 'not_configured',
                message: wasConnected ? 'Previously connected' : 'Not connected',
                phone_number: null
            };
        }

        return {
            connected: session.status === 'connected',
            status: session.status,
            phone_number: session.phoneNumber,
            message: session.status === 'connected' ? 'Active' : 'Connecting...'
        };
    }

    getBufferedQR(businessId) {
        return this.qrBuffer.get(String(businessId)) || null;
    }

    async disconnect(businessId) {
        businessId = String(businessId);

        const session = this.sessions.get(businessId);
        if (session?.socket) {
            try { await session.socket.logout(); } catch(e) {}
        }

        const authFolder = this.getAuthFolder(businessId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });

        this.sessions.delete(businessId);
        this.qrBuffer.delete(businessId);
        this.lidMap.clear();
        this.messageStatusMap.clear();

        await this.notifyLaravel('disconnected', businessId);

        this.io.to(`business-${businessId}`).emit('whatsapp-status', {
            business_id: businessId,
            status: 'disconnected',
            message: 'Disconnected'
        });

        return true;
    }
}

module.exports = WhatsAppService;