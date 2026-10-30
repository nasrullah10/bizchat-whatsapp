import React, { useState } from 'react';
import { useWhatsApp } from './hooks/useWhatsApp';

export default function WhatsAppConnect({ businessId }) {
  const {
    status,
    qrCode,
    messages,
    loading,
    error,
    connect,
    disconnect,
    sendMessage
  } = useWhatsApp(businessId);

  const [phone, setPhone] = useState('');
  const [text, setText] = useState('');

  const isConnected = status?.status === 'connected';
  const hasQR = !!qrCode;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      
      {/* Status Card */}
      <div className={`p-4 rounded-lg mb-6 ${
        isConnected ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'
      } border`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">
              {isConnected ? '✅ Connected' : hasQR ? '📱 QR Ready' : '⚠️ Not Connected'}
            </h2>
            {status?.phone_number && (
              <p className="text-sm text-gray-600">{status.phone_number}</p>
            )}
          </div>
          
          {isConnected ? (
            <button 
              onClick={disconnect}
              className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
            >
              Disconnect
            </button>
          ) : (
            <button 
              onClick={connect}
              disabled={loading}
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
            >
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {/* QR Code */}
      {hasQR && !isConnected && (
        <div className="bg-white p-6 rounded-lg shadow mb-6 text-center">
          <h3 className="text-lg font-semibold mb-4">Scan QR Code</h3>
          <img src={qrCode} alt="WhatsApp QR" className="w-64 h-64 mx-auto mb-4" />
          <p className="text-sm text-gray-500">
            Open WhatsApp → Settings → Linked Devices → Link a Device
          </p>
        </div>
      )}

      {/* Send Message */}
      {isConnected && (
        <div className="bg-white p-6 rounded-lg shadow mb-6">
          <h3 className="text-lg font-semibold mb-4">Send Message</h3>
          <div className="space-y-4">
            <input
              type="text"
              placeholder="Phone (e.g. 923001234567)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full p-2 border rounded"
            />
            <textarea
              placeholder="Message..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full p-2 border rounded h-24"
            />
            <button
              onClick={() => {
                sendMessage(phone, text);
                setText('');
              }}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Messages ({messages.length})</h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {messages.map((msg) => (
              <div key={msg.id} className={`p-3 rounded ${
                msg.direction === 'incoming' ? 'bg-blue-50' : 'bg-green-50'
              }`}>
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>{msg.from || msg.to}</span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
                <p className="text-sm">{msg.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-red-50 text-red-600 rounded">
          {error}
        </div>
      )}
    </div>
  );
}