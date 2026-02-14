export class ChatBox {
  constructor(network) {
    this.network = network;
    this.chatLog = document.getElementById('chat-log');
    this.chatInput = document.getElementById('chat-input');
    this.isOpen = false;

    this.setupEvents();
  }

  setupEvents() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (this.isOpen) {
          this.sendMessage();
        } else {
          this.open();
        }
        e.preventDefault();
      }
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }

  open() {
    this.isOpen = true;
    this.chatInput.classList.add('active');
    this.chatInput.focus();
  }

  close() {
    this.isOpen = false;
    this.chatInput.classList.remove('active');
    this.chatInput.value = '';
    this.chatInput.blur();
  }

  sendMessage() {
    const msg = this.chatInput.value.trim();
    if (msg) {
      this.network.sendChat(msg);
    }
    this.close();
  }

  addMessage(name, message) {
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="name">[${this.escapeHtml(name)}]</span> ${this.escapeHtml(message)}`;
    this.chatLog.appendChild(div);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;

    // Remove old messages (keep last 50)
    while (this.chatLog.children.length > 50) {
      this.chatLog.removeChild(this.chatLog.firstChild);
    }
  }

  addSystemMessage(message) {
    const div = document.createElement('div');
    div.className = 'chat-message';
    div.innerHTML = `<span class="system">${this.escapeHtml(message)}</span>`;
    this.chatLog.appendChild(div);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
