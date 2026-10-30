// services/autoReplyService.js
const axios = require('axios');

class AutoReplyService {
    constructor() {
        this.laravelUrl = process.env.LARAVEL_URL || 'http://localhost:8000';
        console.log('🤖 AutoReplyService initialized');
        console.log('🤖 Laravel URL:', this.laravelUrl);
    }

    /**
     * 🎯 MAIN METHOD: Process incoming message (called by Bailey)
     */
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

            // 🆕 Step 3: Build reply with VARIABLE REPLACEMENT (including products)
            const replyContent = await this.buildReply(matchedTemplate, customerPhone, businessId);
            console.log(`🎯 Reply: "${replyContent.text.substring(0, 100)}..."`);

            // Track usage
            this.trackUsage(matchedTemplate.id);

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

    /**
     * 🆕 BUILD REPLY WITH VARIABLE REPLACEMENT (including {{product_list}})
     */
    async buildReply(template, customerPhone, businessId) {
        let content = template.content || '';

        // Replace basic variables
        content = content.replace(/{{customer_name}}/g, 'Customer');
        content = content.replace(/{{business_name}}/g, 'BizChat Pro');
        content = content.replace(/{{phone}}/g, customerPhone);

        // 🛍️ REPLACE {{product_list}} WITH ACTUAL PRODUCTS
        if (content.includes('{{product_list}}') || template.include_products) {
            const productList = await this.fetchProductList(businessId, template);
            
            if (content.includes('{{product_list}}')) {
                content = content.replace(/{{product_list}}/g, productList);
            } else if (template.include_products) {
                content += '\n\n' + productList;
            }
        }

        // Replace other variables
        content = content.replace(/{{order_status}}/g, 'Processing');
        content = content.replace(/{{complaint_id}}/g, 'N/A');
        content = content.replace(/{{issue}}/g, 'N/A');
        content = content.replace(/{{product_name}}/g, 'Product');
        content = content.replace(/{{price}}/g, '0');
        content = content.replace(/{{address}}/g, 'N/A');
        content = content.replace(/{{order_id}}/g, 'N/A');
        content = content.replace(/{{location}}/g, 'N/A');
        content = content.replace(/{{delivery_date}}/g, '2-3 days');

        return {
            text: content,
            buttons: template.buttons || [],
            media: template.media || null,
            messageType: template.message_type || 'text'
        };
    }

    /**
     * 🆕 FETCH PRODUCTS FROM LARAVEL
     */
    // services/autoReplyService.js
// Change fetchProductList URL from:
// let url = `${this.laravelUrl}/api/products?user_id=${businessId}&limit=${limit}`;
// TO:
// let url = `${this.laravelUrl}/api/products/public/${businessId}?limit=${limit}`;

async fetchProductList(businessId, template) {
    try {
        const category = template.product_category;
        const limit = template.product_limit || 5;

        // 🆕 UPDATED URL - Public endpoint (no auth)
        let url = `${this.laravelUrl}/api/products/public/${businessId}?limit=${limit}`;
        if (category) {
            url += `&category=${encodeURIComponent(category)}`;
        }

        console.log(`🎯 Fetching products from: ${url}`);

        const response = await axios.get(url, { 
            timeout: 5000,
            headers: {
                'Accept': 'application/json'
            }
        });

        const products = response.data?.data || [];

        if (products.length === 0) {
            return '⚠️ Abhi koi product available nahi hai.';
        }

        const lines = ['📦 *Hamare Products:*'];
        
        products.forEach((product, index) => {
            const stockEmoji = product.stock_quantity <= 5 ? '⚠️' : '✅';
            const price = parseFloat(product.price).toLocaleString();
            
            lines.push(
                `${index + 1}️⃣ *${product.name}*`,
                `💰 Rs. ${price}`,
                `📦 Stock: ${product.stock_quantity} ${product.unit || 'piece'} ${stockEmoji}`
            );
            
            if (product.description) {
                lines.push(`📝 ${product.description.substring(0, 50)}`);
            }
            
            lines.push(''); // Empty line
        });

        lines.push('🛒 Order karne ke liye product number bataein!');
        lines.push('📞 Help chahiye toh "HELP" likhein');

        return lines.join('\n');

    } catch (error) {
        console.error(`🎯 ❌ Failed to fetch products:`, error.message);
        if (error.response) {
            console.error(`🎯 Status: ${error.response.status}`);
            console.error(`🎯 Data:`, error.response.data);
        }
        return '⚠️ Products list load nahi ho saki. Baad mein try karein.';
    }
}

    /**
     * Track template usage
     */
    async trackUsage(templateId) {
        try {
            const url = `${this.laravelUrl}/api/whatsapp/templates/${templateId}/track`;
            await axios.post(url, {}, { 
                timeout: 3000,
                headers: {
                    'Accept': 'application/json'
                }
            });
            console.log(`🎯 Usage tracked for template ${templateId}`);
        } catch (error) {
            // Silently fail - not critical
        }
    }
}

module.exports = AutoReplyService;