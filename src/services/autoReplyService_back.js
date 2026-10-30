// services/autoReplyService.js
const axios = require('axios');

class AutoReplyService {
    constructor() {
        this.laravelUrl = process.env.LARAVEL_URL || 'http://localhost:8000';
        console.log('🤖 AutoReplyService initialized');
        console.log('🤖 Laravel URL:', this.laravelUrl);
    }

    async processIncomingMessage(businessId, customerPhone, messageText) {
        console.log(`\n🎯 ========== AUTO REPLY START ==========`);
        console.log(`🎯 Business ID: ${businessId}`);
        console.log(`🎯 Customer: ${customerPhone}`);
        console.log(`🎯 Message: "${messageText}"`);
        
        try {
            // Step 1: Fetch templates
            console.log(`🎯 Step 1: Fetching templates...`);
            const templates = await this.getActiveTemplates(businessId);
            
            if (!templates || templates.length === 0) {
                console.log(`🎯 ❌ No templates found!`);
                console.log(`🎯 ========== AUTO REPLY END ==========\n`);
                return null;
            }

            console.log(`🎯 Found ${templates.length} template(s)`);

            // Step 2: Find matching template
            console.log(`🎯 Step 2: Matching template...`);
            const matchedTemplate = this.findMatchingTemplate(templates, messageText);
            
            if (!matchedTemplate) {
                console.log(`🎯 ❌ No template matched`);
                console.log(`🎯 ========== AUTO REPLY END ==========\n`);
                return null;
            }

            console.log(`🎯 ✅ Matched: "${matchedTemplate.name}"`);

            // Step 3: Build reply
            const replyContent = this.buildReply(matchedTemplate, customerPhone);
            console.log(`🎯 Reply: "${replyContent.text}"`);

            console.log(`🎯 ========== AUTO REPLY END ==========\n`);

            return {
                shouldReply: true,
                content: replyContent,
                template: matchedTemplate
            };

        } catch (error) {
            console.error(`🎯 ❌ Error:`, error.message);
            console.log(`🎯 ========== AUTO REPLY END ==========\n`);
            return null;
        }
    }

    async getActiveTemplates(businessId) {
        try {
            const url = `${this.laravelUrl}/api/whatsapp/templates/active/${businessId}`;
            console.log(`🎯 API URL: ${url}`);

            const response = await axios.get(url, { 
                timeout: 5000,
                headers: {
                    'Accept': 'application/json'
                }
            });
            
            console.log(`🎯 API Response Status: ${response.status}`);
            console.log(`🎯 API Response:`, JSON.stringify(response.data, null, 2));

            if (response.data && response.data.success) {
                return response.data.data || [];
            }
            
            console.log(`🎯 API returned success: false`);
            return [];
            
        } catch (error) {
            console.error(`🎯 ❌ API Error:`, error.message);
            if (error.response) {
                console.error(`🎯 Status: ${error.response.status}`);
                console.error(`🎯 Data:`, error.response.data);
            } else if (error.request) {
                console.error(`🎯 No response received - Laravel down?`);
            }
            return [];
        }
    }

    findMatchingTemplate(templates, messageText) {
        const lowerMessage = messageText.toLowerCase().trim();
        console.log(`🎯 Matching: "${lowerMessage}"`);

        // Sort by priority (highest first)
        const sorted = [...templates].sort((a, b) => (b.priority || 5) - (a.priority || 5));

        for (const template of sorted) {
            const triggers = template.triggers || [];
            console.log(`🎯 Checking: "${template.name}" (priority: ${template.priority})`);
            console.log(`🎯 Triggers: [${triggers.join(', ')}]`);

            for (const trigger of triggers) {
                const lowerTrigger = String(trigger).toLowerCase().trim();
                let matched = false;

                switch (template.match_type) {
                    case 'exact':
                        matched = lowerMessage === lowerTrigger;
                        break;
                    case 'contains':
                        matched = lowerMessage.includes(lowerTrigger);
                        break;
                    case 'starts_with':
                        matched = lowerMessage.startsWith(lowerTrigger);
                        break;
                    case 'regex':
                        try {
                            const regex = new RegExp(lowerTrigger, 'i');
                            matched = regex.test(messageText);
                        } catch (e) {
                            console.error(`🎯 Invalid regex: ${trigger}`);
                        }
                        break;
                    default:
                        matched = lowerMessage.includes(lowerTrigger);
                }

                console.log(`🎯   "${lowerTrigger}" → ${matched ? '✅ MATCH' : '❌ no match'}`);

                if (matched) {
                    return template;
                }
            }
        }

        return null;
    }

    buildReply(template, customerPhone) {
        let content = template.content || '';

        // Replace variables
        content = content.replace(/{{customer_name}}/g, 'Customer');
        content = content.replace(/{{business_name}}/g, 'Our Business');
        content = content.replace(/{{phone}}/g, customerPhone);

        return {
            text: content,
            buttons: template.buttons,
            media: template.media,
            messageType: template.message_type || 'text'
        };
    }

    // services/autoReplyService.js

async trackUsage(templateId) {
    try {
        const url = `${this.laravelUrl}/api/whatsapp/templates/${templateId}/track`;
        await axios.post(url, {}, { 
            timeout: 3000,
            headers: {
                'X-API-Key': 'your-secret-key'
            }
        });
    } catch (error) {
        // Silently fail - not critical
    }
}
}

module.exports = AutoReplyService;