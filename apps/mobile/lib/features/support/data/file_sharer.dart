import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import 'support_repository.dart';

/// Writes the bank's document to the temporary folder and opens the OS share sheet (save, print, email...).
/// Temporary storage is cleared by the OS; nothing is kept in the app's own storage.
class PlatformFileSharer implements FileSharer {
  @override
  Future<void> share(DownloadedFile f) async {
    final dir = await getTemporaryDirectory();
    final safe = f.fileName.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_');
    final file = await File('${dir.path}${Platform.pathSeparator}$safe').writeAsBytes(f.bytes, flush: true);
    await SharePlus.instance.share(ShareParams(files: [XFile(file.path, mimeType: f.mimeType)], subject: f.fileName));
  }
}

final fileSharerProvider = Provider<FileSharer>((ref) => PlatformFileSharer());
