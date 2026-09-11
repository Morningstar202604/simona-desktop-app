package com.simona.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class SimonaApp : Application() {

    companion object {
        const val CHANNEL_ID = "simona_backend_channel"
        const val NOTIF_ID = 1001
        lateinit var instance: SimonaApp
            private set
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Simona 后台服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "保持 Simona 后端在后台运行"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }
}