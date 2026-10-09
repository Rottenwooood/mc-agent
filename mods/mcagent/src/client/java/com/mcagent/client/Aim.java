package com.mcagent.client;

import net.minecraft.client.player.LocalPlayer;

/** Small aiming helpers shared by the controller. */
public final class Aim {

    private Aim() {}

    /** Point the local player at a world position (yaw/pitch), sent with the next movement packet. */
    public static void look(LocalPlayer p, double x, double y, double z) {
        double dx = x - p.getX();
        double dz = z - p.getZ();
        double dy = y - (p.getY() + p.getEyeHeight());
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.toDegrees(Math.atan2(dz, dx))) - 90.0F;
        float pitch = (float) (-Math.toDegrees(Math.atan2(dy, horiz)));
        p.setYRot(yaw);
        p.setXRot(pitch);
    }
}
