package com.mcagent.observer;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.block.state.BlockState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Server-side, read-only observation mod. Exposes authoritative world facts over a local
 * HTTP JSON API for an external agent. It never mutates the world.
 */
public class ObserverMod implements ModInitializer {

    public static final String MOD_ID = "mcagent_observer";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);
    public static final String MOD_VERSION = FabricLoader.getInstance()
            .getModContainer(MOD_ID)
            .map(c -> c.getMetadata().getVersion().getFriendlyString())
            .orElse("unknown");

    public static volatile MinecraftServer server = null;
    public static volatile long tick = 0L;
    public static final EventLog events = new EventLog(4096);

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(s -> {
            server = s;
            tick = 0L;
            events.bumpEpoch();
            HttpApi.start(s);
            LOGGER.info("[{}] server started; observer HTTP at {}", MOD_ID, HttpApi.address());
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
            HttpApi.stop();
            server = null;
        });
        ServerTickEvents.END_SERVER_TICK.register(s -> {
            server = s;
            tick += 1L;
        });
        PlayerBlockBreakEvents.AFTER.register((world, player, pos, state, blockEntity) -> {
            String before = id(state);
            String actor = (player == null) ? "unknown" : player.getName().getString();
            events.add(tick, pos.getX(), pos.getY(), pos.getZ(), before, "minecraft:air", actor);
        });
        LOGGER.info("[{}] initialized", MOD_ID);
    }

    /** Registry id (e.g. minecraft:mangrove_log), consistent with /snapshot. */
    private static String id(BlockState state) {
        ResourceLocation rl = BuiltInRegistries.BLOCK.getKey(state.getBlock());
        return rl == null ? "unknown" : rl.toString();
    }
}
