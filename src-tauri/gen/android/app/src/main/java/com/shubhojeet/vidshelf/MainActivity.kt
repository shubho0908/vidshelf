package com.shubhojeet.vidshelf

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  private fun findWebView(root: View): WebView? {
    if (root is WebView) return root
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        val found = findWebView(root.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }

  @Deprecated("TV remote Back must route into the SPA first")
  override fun onBackPressed() {
    val wv = window.decorView.rootView?.let { findWebView(it) }
    if (wv == null) {
      finishFromBack()
      return
    }
    wv.evaluateJavascript(
      """(function(){ var h = location.hash; if (h === "" || h === "#" || h === "#/") { return "root"; } window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return "nav"; })()"""
    ) { result ->
      if (result != null && result.contains("root")) {
        runOnUiThread { finishFromBack() }
      }
    }
  }

  private fun finishFromBack() {
    @Suppress("DEPRECATION")
    super.onBackPressed()
  }
}
