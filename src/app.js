require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json());

const AutoReplyService = require('./services/autoReplyService');
const autoReply = new AutoReplyService();

const io = new Server(httpServer, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling']
});

// Load service
const WhatsAppService = require('./services/whatsappService');
const waService = new WhatsAppService(io);

// ========== ROUTES ==========

app.get('/health', (req, res) => {
    res.json({ status: 'OK', time: new Date().toISOString() });
});

// Connect WhatsApp
app.post('/api/whatsapp/connect', async (req, res) => {
    try {
        const { business_id } = req.body;
        if (!business_id) {
            return res.status(400).json({ success: false, error: 'business_id required' });
        }

        console.log('\n📥 CONNECT API called for business:', business_id);

        const result = await waService.connect(String(business_id));

        res.json({
            success: true,
            business_id: business_id,
            status: result.status
        });

    } catch (error) {
        console.error('Connect API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Status
app.get('/api/whatsapp/status/:business_id', (req, res) => {
    const status = waService.getStatus(String(req.params.business_id));
    res.json({ success: true, ...status });
});

// Disconnect
app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        await waService.disconnect(String(req.body.business_id));
        res.json({ success: true, message: 'Disconnected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send Message (with campaign tracking support)
app.post('/api/whatsapp/send', async (req, res) => {
    console.log('\n📥 SEND API CALLED:', req.body);
    console.log('📥 Headers:', req.headers);

    try {
        const { business_id, to, message, campaign_id, recipient_id } = req.body;

        if (!business_id || !to || !message) {
            console.log('❌ Missing fields');
            return res.status(400).json({ 
                success: false, 
                error: 'business_id, to, and message are required' 
            });
        }

        // Check session exists
        const session = waService.sessions.get(String(business_id));
        console.log('📥 Session found:', !!session);
        console.log('📥 Session status:', session?.status);
        console.log('📥 Socket exists:', !!session?.socket);

        const cleanPhone = String(to).replace(/\D/g, '');

        // Pass campaign_id and recipient_id for status tracking
        const result = await waService.sendMessage(
            business_id, 
            cleanPhone, 
            message,
            campaign_id || null,
            recipient_id || null
        );

        console.log('✅ Message sent:', result);
        res.json({ success: true, ...result });

    } catch (error) {
        console.error('❌ Send API error:', error.message);
        console.error('❌ Full error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ========== SOCKET.IO ==========

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('subscribe-business', (businessId) => {
        const room = `business-${String(businessId)}`;
        socket.join(room);
        console.log(`Socket ${socket.id} joined ${room}`);

        // Send buffered QR if available
        const buffered = waService.getBufferedQR(String(businessId));
        if (buffered) {
            console.log('Sending buffered QR to new subscriber');
            socket.emit('whatsapp-qr', buffered);
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket disconnected:', socket.id);
    });
});

// ========== START ==========
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}\n`);
});