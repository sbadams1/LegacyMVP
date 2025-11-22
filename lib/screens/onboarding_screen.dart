// lib/screens/onboarding_screen.dart

import 'package:flutter/material.dart';
import 'terms_screen.dart';

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final PageController _pageController = PageController();
  int _currentPage = 0;

  final List<_OnboardingPageData> _pages = const [
    _OnboardingPageData(
      title: 'Capture Your Story',
      body:
          'Record your memories, thoughts, and experiences in your own words, at your own pace.',
      icon: Icons.mic_rounded,
    ),
    _OnboardingPageData(
      title: 'Store Memories Safely',
      body:
          'Your recordings and notes are stored securely in the cloud so they can be revisited later.',
      icon: Icons.cloud,
    ),
    _OnboardingPageData(
      title: 'Build a Lasting Legacy',
      body:
          'In the next step, youʼll confirm your legal name, choose how you want the app to address you, and set your preferred language for conversations. Over time, your stories become a living legacy your loved ones can explore.',
      icon: Icons.favorite_rounded,
    ),
  ];

  void _goToNextPage() {
    if (_currentPage < _pages.length - 1) {
      _pageController.nextPage(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    } else {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const TermsScreen()),
      );
    }
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isLastPage = _currentPage == _pages.length - 1;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 16),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () {
                  Navigator.of(context).pushReplacement(
                    MaterialPageRoute(builder: (_) => const TermsScreen()),
                  );
                },
                child: const Text('Skip'),
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _pageController,
                itemCount: _pages.length,
                onPageChanged: (index) {
                  setState(() {
                    _currentPage = index;
                  });
                },
                itemBuilder: (context, index) {
                  final page = _pages[index];
                  return LayoutBuilder(
                    builder: (context, constraints) {
                      return SingleChildScrollView(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 24,
                          vertical: 8,
                        ),
                        child: ConstrainedBox(
                          constraints: BoxConstraints(
                            minHeight: constraints.maxHeight - 16,
                          ),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                page.icon,
                                size: 96,
                              ),
                              const SizedBox(height: 32),
                              Text(
                                page.title,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.headlineSmall?.copyWith(
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                              const SizedBox(height: 16),
                              Text(
                                page.body,
                                textAlign: TextAlign.center,
                                softWrap: true,
                                style: theme.textTheme.bodyLarge,
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  );
                },
              ),
            ),
            const SizedBox(height: 16),
            _buildDots(),
            const SizedBox(height: 16),
            Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 24.0, vertical: 16),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _goToNextPage,
                  child: Text(isLastPage ? 'Continue' : 'Next'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDots() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: List.generate(
        _pages.length,
        (index) {
          final isActive = index == _currentPage;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            margin: const EdgeInsets.symmetric(horizontal: 4),
            height: 8,
            width: isActive ? 20 : 8,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              color: isActive ? Colors.blueGrey : Colors.grey.shade400,
            ),
          );
        },
      ),
    );
  }
}

class _OnboardingPageData {
  final String title;
  final String body;
  final IconData icon;

  const _OnboardingPageData({
    required this.title,
    required this.body,
    required this.icon,
  });
}
