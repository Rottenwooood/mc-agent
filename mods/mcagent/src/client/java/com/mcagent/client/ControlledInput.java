package com.mcagent.client;

import net.minecraft.client.player.Input;

/**
 * Player input driven by the controller instead of the keyboard.
 *
 * <p>Vanilla {@code KeyboardInput.tick()} recomputes the movement impulses from the keybindings
 * every tick, which would overwrite anything we set. We replace the local player's {@code input}
 * with this no-op variant so the values we write (from the navigation / steer logic) persist and
 * drive the original, player-legal kinematics. The server sees ordinary movement input.
 */
public final class ControlledInput extends Input {

    @Override
    public void tick(boolean isMovingSlowly, float yRot) {
        // Deliberately empty: the controller owns these fields.
    }

    public void reset() {
        this.up = false;
        this.down = false;
        this.left = false;
        this.right = false;
        this.jumping = false;
        this.shiftKeyDown = false;
        this.forwardImpulse = 0.0F;
        this.leftImpulse = 0.0F;
    }

    /** Set forward (+1) / back (-1) and left (+1) / right (-1) impulses. */
    public void move(float forward, float left) {
        this.forwardImpulse = clamp(forward);
        this.leftImpulse = clamp(left);
        this.up = forward > 0.0F;
        this.down = forward < 0.0F;
        this.left = left > 0.0F;
        this.right = left < 0.0F;
    }

    private static float clamp(float v) {
        return Math.max(-1.0F, Math.min(1.0F, v));
    }
}
