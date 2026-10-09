package com.mcagent.client.mixin;

import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/**
 * Accessor for {@link Player#closeContainer()} (protected). Used by the controller to close a
 * container menu from a non-screen context (we drive the player, not a GUI).
 */
@Mixin(Player.class)
public interface PlayerAccessor {

    @Invoker("closeContainer")
    void mcagent$closeContainer();
}
