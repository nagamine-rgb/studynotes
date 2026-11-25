// `tauri android init` で生成された Android プロジェクトに、StudyNotes 用の設定を書き足す（CI で実行）
//  1. Dropsync などの同期フォルダを読み書きするための「すべてのファイルへのアクセス」権限
//  2. 起動時に、その権限がなければ許可画面を開く（MainActivity）
//  3. リリース用の署名（keystore.properties があるとき）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "src-tauri/gen/android";
if (!existsSync(root)) throw new Error(`${root} がありません。先に tauri android init を実行してください`);

function patch(file, fn) {
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === before) console.log(`(変更なし) ${file}`);
  else console.log(`更新: ${file}`);
  writeFileSync(file, after);
}

function must(text, needle, file) {
  if (!text.includes(needle)) throw new Error(`${file} に「${needle}」が見つかりません（テンプレートが変わった可能性）`);
}

// 1. 権限
const manifest = join(root, "app/src/main/AndroidManifest.xml");
patch(manifest, (s) => {
  must(s, "<application", manifest);
  const perms = [
    '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  ].filter((p) => !s.includes(p.split('"')[1]));
  if (perms.length) s = s.replace("<application", `${perms.join("\n    ")}\n\n    <application`);
  if (!s.includes("requestLegacyExternalStorage")) s = s.replace("<application", '<application\n        android:requestLegacyExternalStorage="true"');
  // キーボード表示時に画面を縮める（書式バーがキーボードの上に来る）
  if (!s.includes("windowSoftInputMode")) s = s.replace(/<activity(\s)/, '<activity\n            android:windowSoftInputMode="adjustResize"$1');
  return s;
});

// 2. MainActivity
function findFile(dir, name) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e === name) return p;
  }
  return null;
}
const activity = findFile(join(root, "app/src/main"), "MainActivity.kt");
if (!activity) throw new Error("MainActivity.kt が見つかりません");
const pkg = /^package\s+([\w.]+)/m.exec(readFileSync(activity, "utf8"))?.[1];
if (!pkg) throw new Error("MainActivity.kt の package が読めません");
writeFileSync(
  activity,
  `package ${pkg}

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestStorageAccess()
  }

  // 同期フォルダ（例：/storage/emulated/0/Dropsync）を読み書きできるよう、
  // 「すべてのファイルへのアクセス」が未許可なら設定画面を開く
  private fun requestStorageAccess() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!Environment.isExternalStorageManager()) {
        try {
          startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
          startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
      }
    } else if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
    }
  }
}
`,
);
console.log(`更新: ${activity}`);

// 3. 署名
const gradle = join(root, "app/build.gradle.kts");
if (existsSync(join(root, "keystore.properties"))) {
  patch(gradle, (s) => {
    if (s.includes('signingConfigs.getByName("release")')) return s;
    must(s, "buildTypes {", gradle);
    must(s, 'getByName("release") {', gradle);
    must(s, "android {", gradle);
    // android { } の中では "java" が Java の設定を指してしまうので、import して外側で読み込む
    for (const imp of ["import java.util.Properties", "import java.io.FileInputStream"]) {
      if (!new RegExp(`^${imp.replace(/\./g, "\\.")}\\s*$`, "m").test(s)) s = `${imp}\n${s}`;
    }
    s = s.replace(
      "android {",
      `val studynotesKeystore = Properties().apply { load(FileInputStream(rootProject.file("keystore.properties"))) }

android {`,
    );
    s = s.replace(
      "buildTypes {",
      `signingConfigs {
        create("release") {
            keyAlias = studynotesKeystore["keyAlias"] as String
            keyPassword = studynotesKeystore["password"] as String
            storeFile = file(studynotesKeystore["storeFile"] as String)
            storePassword = studynotesKeystore["password"] as String
        }
    }
    buildTypes {`,
    );
    s = s.replace('getByName("release") {', 'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")');
    return s;
  });
} else {
  console.log("keystore.properties がないため、署名なしでビルドします");
}
