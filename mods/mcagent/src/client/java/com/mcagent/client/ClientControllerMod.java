package com.mcagent.client;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Client entrypoint: turns the local player of a real Minecraft client into a controllable body
 * behind the same ControlPort primitive set (docs/client-controller.md). Starts the local control
 * HTTP API and drives the tick scheduler.
 */
public class ClientControllerMod implements ClientModInitializer {

    public static final String MOD_ID = "mcagent";
    public static final Logger LOGGER = LoggerFactory.getLogger("mcagent-client");
    public static final String MOD_VERSION = FabricLoader.getInstance()
            .getModContainer(MOD_ID)
            .map(c -> c.getMetadata().getVersion().getFriendlyString())
            .orElse("unknown");

    private ControlDispatcher dispatcher;
    private PlayerActions actions;
    private boolean started;

    @Override
    public void onInitializeClient() {
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (!started) {
                start(client);
                started = true;
            }
            if (client.player != null) {
                if (dispatcher.busy()) {
                    actions.ensureInput();
                } else {
                    actions.releaseInput();
                }
            }
            dispatcher.tick();
        });
    }

    private void start(Minecraft client) {
        ControlledInput input = new ControlledInput();
        actions = new PlayerActions(client, input);
        ClientReads reads = new ClientReads(client);
        dispatcher = new ControlDispatcher(client);
        ControlHttp.start(controlPort(), client, dispatcher, actions, reads);
        LOGGER.info("[mcagent] client controller ready (mod {}, control HTTP {})", MOD_VERSION, ControlHttp.address());
    }

    private static int controlPort() {
        String v = System.getProperty("mcagent.control.port", System.getenv("MCAGENT_CONTROL_PORT"));
        if (v == null || v.isBlank()) {
            return 8766;
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return 8766;
        }
    }
}
