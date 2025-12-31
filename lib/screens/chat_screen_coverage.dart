part of 'chat_screen.dart';


class CoverageScreen extends StatelessWidget {
  const CoverageScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final client = Supabase.instance.client;
    final user = client.auth.currentUser;

    if (user == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Coverage')),
        body: const Center(
          child: Text('Please sign in to view coverage.'),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Coverage')),
      body: _CoverageView(
        supabase: client,
        userId: user.id,
      ),
    );
  }
}

class _CoverageView extends StatefulWidget {
  final SupabaseClient supabase;
  final String userId;

  const _CoverageView({
    required this.supabase,
    required this.userId,
  });

  @override
  State<_CoverageView> createState() => _CoverageViewState();
}

class _CoverageViewState extends State<_CoverageView> {
  Map<String, dynamic>? _coverage;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadCoverage();
  }

  Future<void> _loadCoverage() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final res = await widget.supabase
          .from('coverage_map_json')
          .select('data')
          .eq('user_id', widget.userId)
          .maybeSingle();

      if (res == null) {
        setState(() {
          _coverage = null;
          _loading = false;
        });
        return;
      }

      final data = res['data'];
      if (data is Map<String, dynamic>) {
        setState(() {
          _coverage = data;
          _loading = false;
        });
      } else {
        setState(() {
          _error = 'Unexpected coverage_map_json.data shape.';
          _loading = false;
        });
      }
    } catch (e) {
      setState(() {
        _error = 'Failed to load coverage: $e';
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Error loading coverage',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                _error!,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              ElevatedButton(
                onPressed: _loadCoverage,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (_coverage == null) {
      return const Center(
        child: Text(
          'No coverage data yet.\nTry recording some legacy stories first.',
          textAlign: TextAlign.center,
        ),
      );
    }

    final global = _coverage!['global'] as Map<String, dynamic>? ?? {};
    final chapters = (_coverage!['chapters'] as Map?) ?? {};

    final totalMemories = (global['total_memories'] ?? 0) as int;
    final totalWords = (global['total_words_estimate'] ?? 0) as int;
    final earliestYear = global['earliest_year'];
    final latestYear = global['latest_year'];
    final themes = (global['dominant_themes'] as List?) ?? const [];

        // Define a sensible fixed order for chapters
    const orderedKeys = [
      'early_childhood',
      'adolescence',
      'early_adulthood',
      'midlife',
      'later_life',
      'family_relationships',
      'work_career',
      'education',
      'health_wellbeing',
      'hobbies_interests',
      'beliefs_values',
      'major_events',
    ];

    final chapterEntries = chapters.entries
        .where((e) => e.value is Map)
        .map<Map<String, dynamic>>((e) {
      final m = e.value as Map;
      return {
        'key': m['key'] ?? e.key,
        'label': m['label'] ?? e.key,
        'coverage_score': (m['coverage_score'] ?? 0.0) as num,
        'memory_count': (m['memory_count'] ?? 0) as int,
        'summary_snippet': m['summary_snippet'],
      };
    }).toList()
      ..sort((a, b) {
        final keyA = a['key'] as String;
        final keyB = b['key'] as String;

        final idxA = orderedKeys.indexOf(keyA);
        final idxB = orderedKeys.indexOf(keyB);

        // If both are in our known list, sort by that order
        if (idxA != -1 && idxB != -1) {
          return idxA.compareTo(idxB);
        }
        // If only one is known, known one comes first
        if (idxA != -1) return -1;
        if (idxB != -1) return 1;

        // Fallback: alphabetical by label
        return (a['label'] as String)
            .toLowerCase()
            .compareTo((b['label'] as String).toLowerCase());
      });

    final bottomInset = MediaQuery.of(context).padding.bottom;

    return RefreshIndicator(
      onRefresh: _loadCoverage,
      child: ListView(
        padding: EdgeInsets.fromLTRB(
          16,
          16,
          16,
          16 + bottomInset + 24, // extra cushion above Android nav bar
        ),
        children: [
          _buildGlobalCard(
            context,
            totalMemories: totalMemories,
            totalWords: totalWords,
            earliestYear: earliestYear,
            latestYear: latestYear,
            themes: themes.cast<String>(),
          ),
          const SizedBox(height: 16),
          Text(
            'Chapters',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          if (chapterEntries.isEmpty)
            const Text('No chapters have coverage yet.')
          else
            ...chapterEntries.map((c) => _buildChapterCard(context, c)),
        ],
      ),
    );
  }

  Widget _buildGlobalCard(
    BuildContext context, {
    required int totalMemories,
    required int totalWords,
    dynamic earliestYear,
    dynamic latestYear,
    required List<String> themes,
  }) {
    final theme = Theme.of(context);

    String timeSpan;
    if (earliestYear == null && latestYear == null) {
      timeSpan = 'Not enough data yet';
    } else if (earliestYear == latestYear) {
      timeSpan = 'Around $earliestYear';
    } else {
      timeSpan = '$earliestYear – $latestYear';
    }

    return Card(
      elevation: 1,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Your Life Story Coverage',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text('Memories captured: $totalMemories'),
            Text('Estimated words recorded: $totalWords'),
            Text('Time span covered: $timeSpan'),
            const SizedBox(height: 8),
            if (themes.isNotEmpty) ...[
              Text(
                'Dominant themes:',
                style: theme.textTheme.bodyMedium!
                    .copyWith(fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: themes
                    .map(
                      (t) => Chip(
                        label: Text(t),
                        visualDensity: VisualDensity.compact,
                      ),
                    )
                    .toList(),
              ),
            ] else
              const Text('Themes: Not enough data yet'),
          ],
        ),
      ),
    );
  }

  Widget _buildChapterCard(
    BuildContext context,
    Map<String, dynamic> chapter,
  ) {
    final label = chapter['label'] as String? ?? chapter['key'] as String;
    final score =
        (chapter['coverage_score'] as num).toDouble().clamp(0.0, 1.0);
    final memoryCount = chapter['memory_count'] as int? ?? 0;
    final snippet = chapter['summary_snippet'] as String?;

    final percent = (score * 100).round();

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      elevation: 0.5,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Row(
              children: [
                Expanded(
                  child: LinearProgressIndicator(
                    value: score,
                    minHeight: 6,
                  ),
                ),
                const SizedBox(width: 8),
                Text('$percent%'),
              ],
            ),
            const SizedBox(height: 4),
            Text('Memories in this chapter: $memoryCount'),
            if (snippet != null && snippet.trim().isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                snippet,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: Colors.grey),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// ============================================================================
// FULL-SCREEN VIDEO PLAYER
// ============================================================================
