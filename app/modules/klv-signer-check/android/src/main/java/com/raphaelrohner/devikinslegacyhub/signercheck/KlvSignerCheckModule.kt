/*
 * KlvSignerCheckModule.kt — "is the KLV Signer on this phone the real one?"
 * =========================================================================
 *
 * Every Android app carries a seal: the signing certificate its maker signed
 * it with. Nobody else can copy that seal. Before the Hub sends anything to
 * the KLV Signer, it asks Android whether the app installed under the
 * Signer's name carries the official Signer seal. A fake app installed under
 * that name (from an unofficial source) would carry a different seal, and
 * the Hub then refuses to talk to it (see src/api/klvSigner.js).
 *
 * JavaScript can't ask Android this directly, hence this tiny native helper.
 * It only READS public information about an installed app; it needs no
 * permission (the Signer is already listed in the manifest's <queries>, see
 * plugins/withKlvSigner.js, otherwise Android would hide it).
 *
 * signerStatus(packageName, certSha256Hex) returns one of:
 *   "official"       installed and signed with that certificate
 *                    (Android also accepts earlier keys of an official key
 *                    change, which it keeps a history of)
 *   "different"      installed, but signed with another certificate: a fake
 *   "not_installed"  no app with that name on this phone
 *   "unknown"        couldn't be checked (bad input, very old Android, error)
 *
 * Rules from the KLV Signer project's SIGNER-PROTOCOL.md, section 2c.
 */

package com.raphaelrohner.devikinslegacyhub.signercheck

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KlvSignerCheckModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KlvSignerCheck")

    Function("signerStatus") { packageName: String, certSha256Hex: String ->
      signerStatus(appContext.reactContext, packageName, certSha256Hex)
    }
  }

  private fun signerStatus(context: Context?, packageName: String, certSha256Hex: String): String {
    // hasSigningCertificate exists from Android 9; the Signer itself needs Android 12.
    if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "unknown"
    if (!certSha256Hex.matches(Regex("^[0-9a-fA-F]{64}$"))) return "unknown"
    val pm = context.packageManager
    return try {
      pm.getPackageInfo(packageName, 0) // throws if not installed (or hidden)
      val cert = ByteArray(32) { i -> certSha256Hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
      if (pm.hasSigningCertificate(packageName, cert, PackageManager.CERT_INPUT_SHA256)) "official" else "different"
    } catch (e: PackageManager.NameNotFoundException) {
      "not_installed"
    } catch (e: Exception) {
      "unknown"
    }
  }
}
