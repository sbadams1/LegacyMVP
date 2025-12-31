part of 'chat_screen.dart';

extension _ChatScreenWidgetsExt on _ChatScreenState {

  Widget _buildEmptyState(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: const [
            Text(
              "What's on your mind today?",
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            SizedBox(height: 12),
            Text('You can:', style: TextStyle(fontSize: 14)),
            SizedBox(height: 8),
            Text('• Continue your legacy interview',
                style: TextStyle(fontSize: 14)),
            Text('• Tell a story about something that happened today',
                style: TextStyle(fontSize: 14)),
            Text("• Vent about something that's bothering you",
                style: TextStyle(fontSize: 14)),
            Text('• Share a memory from childhood',
                style: TextStyle(fontSize: 14)),
          ],
        ),
      ),
    );
  }

  Widget _buildMessageList(ThemeData theme) {
    return ListView.builder(
      controller: _scrollController,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
      itemCount: _messages.length,
      itemBuilder: (context, i) {
        final msg = _messages[i];
        final isUser = msg.isUser;

        final alignment =
            isUser ? Alignment.centerRight : Alignment.centerLeft;

        final bubbleColor = isUser
            ? theme.colorScheme.primary
            : theme.colorScheme.surfaceVariant;

        final textColor = isUser
            ? theme.colorScheme.onPrimary
            : theme.colorScheme.onSurface;

        return Align(
          alignment: alignment,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
            decoration: BoxDecoration(
              color: bubbleColor,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // IMAGE
                if (msg.imageUrl != null) ...[
                  GestureDetector(
                    onTap: () {
                      showDialog(
                        context: context,
                        builder: (_) => Dialog(
                          child: InteractiveViewer(
                            child: Image.network(
                              msg.imageUrl!,
                              fit: BoxFit.contain,
                            ),
                          ),
                        ),
                      );
                    },
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: Image.network(
                        msg.imageUrl!,
                        height: 200,
                        width: 200,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => const SizedBox(
                          height: 80,
                          child: Center(
                            child: Text('Image failed to load'),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],

                // VIDEO
                if (msg.videoUrl != null) ...[
                  GestureDetector(
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) =>
                              VideoPlayerScreen(videoUrl: msg.videoUrl!),
                        ),
                      );
                    },
                    child: Container(
                      width: 220,
                      height: 130,
                      decoration: BoxDecoration(
                        color: Colors.black12,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Center(
                        child: Icon(
                          Icons.play_circle_fill,
                          size: 48,
                          color: Colors.black54,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],

                // TEXT + speaker
                if (msg.text.isNotEmpty)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Text(
                          _stripLeadingTagsForDisplay(msg.text),
                          style: TextStyle(color: textColor),
                        ),

                      ),
                      if (!isUser)
                        IconButton(
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(),
                          icon: Icon(
                            Icons.volume_up,
                            size: 18,
                            color: textColor.withOpacity(0.9),
                          ),
                          tooltip: 'Play this message',
                          onPressed: () => _playTtsForMessage(msg),
                        ),
                    ],
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildMediaToolbar() {
    return Container(
      width: double.infinity,
      color:
          Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        children: [
          TextButton.icon(
            onPressed: _onAddPhotoPressed,
            icon: const Icon(Icons.photo),
            label: const Text('Add Photo'),
          ),
          const SizedBox(width: 8),
          TextButton.icon(
            onPressed: _onAddVideoPressed,
            icon: const Icon(Icons.videocam),
            label: const Text('Add Video'),
          ),
        ],
      ),
    );
  }

  Widget _buildRecordingIndicator() {
    return Container(
      color: Colors.red.withOpacity(0.08),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          const Icon(Icons.fiber_manual_record, color: Colors.red),
          const SizedBox(width: 8),
          Text(
            'Recording… ${_formatDuration(_recordDuration)}',
            style: const TextStyle(color: Colors.red),
          ),
          const Spacer(),
          TextButton(
            onPressed: _stopRecordingAndSend,
            child: const Text('Stop & Transcribe'),
          ),
        ],
      ),
    );
  }

  Widget _buildSpeakingModeChip(ThemeData theme) {
    final hasTarget = _hasTargetLanguage;
    final isNative = _isSpeakingNative;

    // What label to show on the chip.
    final label = hasTarget
        ? (isNative ? 'Speaking: Native' : 'Speaking: Target')
        : 'Speaking: Native';

    return InkWell(
      onTap: () {
        if (!hasTarget) {
          // No distinct target language configured; explain to the user.
          _showSnack(
            'Set a target language in preferences to enable native/target mic toggle.',
          );
          return;
        }

        setState(() {
          if (_speakingMode == 'native') {
            _speakingMode = 'target';
            if (_targetLocale != null && _targetLocale!.isNotEmpty) {
              _sttLanguageCode = _targetLocale!;
            }
          } else {
            _speakingMode = 'native';
            _sttLanguageCode = _preferredLocale;
          }
        });

        _showSnack(
          _speakingMode == 'native'
              ? 'Mic will listen in your native language.'
              : 'Mic will listen in the language you are learning.',
        );
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        margin: const EdgeInsets.only(right: 4),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceVariant.withOpacity(0.7),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            color: theme.colorScheme.onSurface.withOpacity(0.8),
          ),
        ),
      ),
    );
  }

  Widget _buildInputBar(ThemeData theme) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.06),
              blurRadius: 4,
              offset: const Offset(0, -2),
            ),
          ],
        ),
        child: Row(
          children: [
            IconButton(
              onPressed: () async {
                if (!_micEnabled) {
                  _showSnack(
                    'Mic is OFF. Enable it using the top-right mic icon.',
                  );
                  return;
                }
                if (_isRecording) {
                  await _stopRecordingAndSend();
                } else {
                  await _startRecording();
                }
              },
              icon: Icon(
                _isRecording ? Icons.stop : Icons.mic,
                color: _micEnabled
                    ? theme.colorScheme.primary
                    : theme.disabledColor,
              ),
            ),
            const SizedBox(width: 4),
           
            Expanded(
              child: TextField(
                controller: _textController,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _handleSendPressed(),
                decoration: const InputDecoration(
                  hintText: 'Type a message or record your story…',
                  border: OutlineInputBorder(),
                  isDense: true,
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                ),
                minLines: 1,
                maxLines: 4,
              ),
            ),
            const SizedBox(width: 8),

            IconButton(
              icon: const Icon(Icons.push_pin),
              tooltip: 'Pin as story seed',
              onPressed: _pinStorySeed,
            ),

            const SizedBox(width: 4),

            IconButton(
              onPressed: _isSending ? null : _handleSendPressed,
              icon: _isSending
                ? const SizedBox(
                width: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : const Icon(Icons.send),
            ),
          ],
        ),
      ),
    );
  }
}
