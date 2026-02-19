import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatBox } from '../../client/ui/ChatBox.js';

function createMockDOM() {
  // Create mock chat-log element
  const chatLog = document.createElement('div');
  chatLog.id = 'chat-log';
  document.body.appendChild(chatLog);

  // Create mock chat-input element
  const chatInput = document.createElement('input');
  chatInput.id = 'chat-input';
  chatInput.classList = document.createElement('div').classList;
  document.body.appendChild(chatInput);

  return { chatLog, chatInput };
}

function createMockNetwork() {
  return {
    sendChat: vi.fn(),
  };
}

describe('ChatBox', () => {
  let chatBox, network, chatLog, chatInput;

  beforeEach(() => {
    document.body.innerHTML = '';
    const dom = createMockDOM();
    chatLog = dom.chatLog;
    chatInput = dom.chatInput;
    network = createMockNetwork();
    chatBox = new ChatBox(network);
  });

  describe('escapeHtml', () => {
    it('escapes < and > characters', () => {
      const result = chatBox.escapeHtml('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });

    it('escapes & character', () => {
      const result = chatBox.escapeHtml('a & b');
      expect(result).toContain('&amp;');
    });

    it('passes through normal text unchanged', () => {
      expect(chatBox.escapeHtml('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(chatBox.escapeHtml('')).toBe('');
    });
  });

  describe('open/close', () => {
    it('open sets isOpen to true', () => {
      chatBox.open();
      expect(chatBox.isOpen).toBe(true);
    });

    it('close sets isOpen to false', () => {
      chatBox.open();
      chatBox.close();
      expect(chatBox.isOpen).toBe(false);
    });

    it('close clears input value', () => {
      chatBox.open();
      chatInput.value = 'some text';
      chatBox.close();
      expect(chatInput.value).toBe('');
    });
  });

  describe('sendMessage', () => {
    it('sends non-empty message via network', () => {
      chatBox.open();
      chatInput.value = 'hello!';
      chatBox.sendMessage();
      expect(network.sendChat).toHaveBeenCalledWith('hello!');
    });

    it('does not send empty message', () => {
      chatBox.open();
      chatInput.value = '   ';
      chatBox.sendMessage();
      expect(network.sendChat).not.toHaveBeenCalled();
    });

    it('closes chat after sending', () => {
      chatBox.open();
      chatInput.value = 'hi';
      chatBox.sendMessage();
      expect(chatBox.isOpen).toBe(false);
    });
  });

  describe('addMessage', () => {
    it('adds a message element to chat log', () => {
      chatBox.addMessage('Alice', 'Hello!');
      expect(chatLog.children.length).toBe(1);
      expect(chatLog.children[0].innerHTML).toContain('Alice');
      expect(chatLog.children[0].innerHTML).toContain('Hello!');
    });

    it('escapes HTML in name and message', () => {
      chatBox.addMessage('<script>', '<b>bold</b>');
      const html = chatLog.children[0].innerHTML;
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<b>bold</b>');
    });

    it('caps messages at 50', () => {
      for (let i = 0; i < 55; i++) {
        chatBox.addMessage('User', `Message ${i}`);
      }
      expect(chatLog.children.length).toBe(50);
    });

    it('removes oldest messages when over 50', () => {
      for (let i = 0; i < 55; i++) {
        chatBox.addMessage('User', `Message ${i}`);
      }
      // First message should be Message 5 (0-4 removed)
      expect(chatLog.children[0].innerHTML).toContain('Message 5');
    });
  });

  describe('addSystemMessage', () => {
    it('adds a system message element', () => {
      chatBox.addSystemMessage('Player joined!');
      expect(chatLog.children.length).toBe(1);
      expect(chatLog.children[0].innerHTML).toContain('Player joined!');
      expect(chatLog.children[0].innerHTML).toContain('system');
    });

    it('escapes HTML in system messages', () => {
      chatBox.addSystemMessage('<img src=x onerror=alert(1)>');
      expect(chatLog.children[0].innerHTML).not.toContain('<img');
    });
  });
});
