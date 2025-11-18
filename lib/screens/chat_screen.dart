// lib/screens/chat_screen.dart
//
// Simple chat UI wired to AIBrainService (Supabase Edge Function "ai-brain").
// - Shows a greeting and some quick suggestions.
// - Lets the user type a message and see the brain's reply.

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../services/ai_brain_service.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final SupabaseClient _supabase = Supabase.instance.client;

  final TextEditingController _textController = TextEditingController();
  final List<_ChatMessage> _messages = <_ChatMessage>[];

  bool _isSending = false;

  String? get _currentUserId => _supabase.auth.currentUser?.id;

  @override
  void dispose() {
    _textController.dispose();
    super.dispose();
  }

  Future<void> _sendMessage({String? presetText}) async {
    final userId = _currentUserId;

    if (userId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('You must be logged in to chat with the brain.'),
        ),
      );
      return;
    }

    final text = presetText ?? _textController.text.trim();
    if (text.isEmpty) return;

    setState(() {
      _isSending = true;
      _messages.add(
        _ChatMessage(
          text: text,
          isUser: true,
          createdAt: DateTime.now(),
        ),
      );
      _textController.clear();
    });

    final reply = await AIBrainService.instance.askBrain(
      userId: userId,
      message: text,
    );

    setState(() {
      _messages.add(
        _ChatMessage(
          text: reply,
          isUser: false,
          createdAt: DateTime.now(),
        ),
      );
      _isSending = false;
    });
  }

  void _usePrompt(String prompt) {
    // Option 1: send immediately
    // _sendMessage(presetText: prompt);

    // Option 2: just drop into the text field for editing first:
    _textController.text = prompt;
    _textController.selection = TextSelection.fromPosition(
      TextPosition(offset: _textController.text.length),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Legacy AI Companion'),
      ),
      body: SafeArea(
        child: Column(
          children: <Widget>[
            _buildIntroCard(),
            const Divider(height: 1),
            Expanded(child: _buildMessagesList()),
            _buildInputArea(),
          ],
        ),
      ),
    );
  }

  Widget _buildIntroCard() {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Card(
        elevation: 2,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text(
                "What's on your mind today?",
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'You can continue your legacy interview, tell a story, or just vent a little.',
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  _quickPromptChip(
                    'Continue my legacy interview',
                    "Help me continue my legacy interview. Ask me another question about my life story.",
                  ),
                  _quickPromptChip(
                    'Tell a story from today',
                    "I want to talk about something that happened today. Please help me reflect on it.",
                  ),
                  _quickPromptChip(
                    'Share a childhood memory',
                    "Ask me about a childhood memory that shaped who I am.",
                  ),
                  _quickPromptChip(
                    'Vent about something',
                    "I need to vent about something that has been bothering me. Help me process it.",
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _quickPromptChip(String label, String promptText) {
    return ActionChip(
      label: Text(label),
      onPressed: () => _usePrompt(promptText),
    );
  }

  Widget _buildMessagesList() {
    if (_messages.isEmpty) {
      return const Center(
        child: Text(
          'Start by telling the brain what is on your mind.',
          textAlign: TextAlign.center,
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      itemCount: _messages.length,
      itemBuilder: (BuildContext context, int index) {
        final msg = _messages[index];
        return _buildMessageBubble(msg);
      },
    );
  }

  Widget _buildMessageBubble(_ChatMessage msg) {
    final alignment =
        msg.isUser ? Alignment.centerRight : Alignment.centerLeft;
    final color =
        msg.isUser ? Colors.blueAccent.shade100 : Colors.grey.shade300;
    final textColor = Colors.black;

    return Align(
      alignment: alignment,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          msg.text,
          style: TextStyle(color: textColor),
        ),
      ),
    );
  }

  Widget _buildInputArea() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: _textController,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) {
                if (!_isSending) {
                  _sendMessage();
                }
              },
              decoration: const InputDecoration(
                hintText: 'Type a message for the brain...',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _isSending
              ? const SizedBox(
                  width: 32,
                  height: 32,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : IconButton(
                  icon: const Icon(Icons.send),
                  onPressed: () {
                    if (!_isSending) {
                      _sendMessage();
                    }
                  },
                ),
        ],
      ),
    );
  }
}

class _ChatMessage {
  final String text;
  final bool isUser;
  final DateTime createdAt;

  _ChatMessage({
    required this.text,
    required this.isUser,
    required this.createdAt,
  });
}
