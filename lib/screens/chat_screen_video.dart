part of 'chat_screen.dart';

class VideoPlayerScreen extends StatefulWidget {
  final String videoUrl;

  const VideoPlayerScreen({super.key, required this.videoUrl});

  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  late VideoPlayerController _controller;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _controller = VideoPlayerController.network(widget.videoUrl)
      ..initialize().then((_) {
        if (!mounted) return;
        setState(() => _ready = true);
        _controller.play();
      });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text(
          'Video',
          style: TextStyle(color: Colors.white),
        ),
      ),
      body: Center(
        child: _ready
            ? AspectRatio(
                aspectRatio: _controller.value.aspectRatio,
                child: VideoPlayer(_controller),
              )
            : const CircularProgressIndicator(),
      ),
      floatingActionButton: _ready
          ? FloatingActionButton(
              onPressed: () {
                setState(() {
                  _controller.value.isPlaying
                      ? _controller.pause()
                      : _controller.play();
                });
              },
              child: Icon(
                _controller.value.isPlaying
                    ? Icons.pause
                    : Icons.play_arrow,
              ),
            )
          : null,
    );
  }

  // ---------------------------------------------------------------------------
  // End Session: "Before you go" reveal sheet (only when summary or moment exists)
  // ---------------------------------------------------------------------------
  Future<void> _showEndSessionRevealSheet({
    Map<String, dynamic>? insightMoment,
    Map<String, dynamic>? endSessionSummary,
  }) async {
    if (!mounted) return;

    String header = "Before you go";
    final String? momentHeader = (insightMoment?["header"] as String?);
    final List<dynamic>? momentBody = insightMoment?["body"] is List ? List<dynamic>.from(insightMoment?["body"] as List) : null;
    final String? momentFootnote = (insightMoment?["footnote"] as String?);

    // Prefer moment header when present
    if (momentHeader != null && momentHeader.trim().isNotEmpty) {
      header = momentHeader;
    }

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (ctx) {
        final media = MediaQuery.of(ctx);
        return Padding(
          padding: EdgeInsets.only(
            left: 16,
            right: 16,
            top: 16,
            bottom: 16 + media.viewInsets.bottom,
          ),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(header, style: Theme.of(ctx).textTheme.titleLarge),
                const SizedBox(height: 12),

                // Insight Moment (if present)
                if (momentBody != null && momentBody.isNotEmpty) ...[
                  for (final line in momentBody)
                    if (line != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(line.toString(), style: Theme.of(ctx).textTheme.bodyLarge),
                      ),
                  if (momentFootnote != null && momentFootnote.trim().isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(momentFootnote, style: Theme.of(ctx).textTheme.bodySmall),
                  ],
                  const SizedBox(height: 16),
                ],

                // Summary (if present)
                if (endSessionSummary != null && endSessionSummary.isNotEmpty) ...[
                  _buildEndSessionSummaryBlock(ctx, endSessionSummary),
                  const SizedBox(height: 16),
                ],

                Row(
                  children: [
                    Expanded(
                      child: ElevatedButton(
                        onPressed: () => Navigator.of(ctx).pop(),
                        child: const Text("Done"),
                      ),
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

  Widget _buildEndSessionSummaryBlock(BuildContext ctx, Map<String, dynamic> summary) {
    final shortSummary = summary["short_summary"]?.toString();
    final fullSummary = summary["full_summary"]?.toString();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text("Saved", style: Theme.of(ctx).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (shortSummary != null && shortSummary.trim().isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(shortSummary, style: Theme.of(ctx).textTheme.bodyLarge),
          ),
        if (fullSummary != null && fullSummary.trim().isNotEmpty)
          Text(fullSummary, style: Theme.of(ctx).textTheme.bodyMedium),
      ],
    );
  }

}
