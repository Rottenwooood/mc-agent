package com.mcagent.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import com.mcagent.client.mixin.PlayerAccessor;

/**
 * The player-legal primitive set implemented against the real client's own interaction manager,
 * inventory and menus. Everything here runs on the client thread; multi-tick primitives are
 * expressed as {@link ControlTask}s stepped by {@link ControlDispatcher}.
 */
public final class PlayerActions {

    private static final int HOTBAR = 9;
    private static final int MAIN = 36;

    private final Minecraft mc;
    private final ControlledInput input;

    public PlayerActions(Minecraft mc, ControlledInput input) {
        this.mc = mc;
        this.input = input;
    }

    public ControlledInput input() {
        return input;
    }

    /** Install the controller input on the local player (idempotent). */
    public void ensureInput() {
        LocalPlayer p = mc.player;
        if (p != null && p.input != input) {
            input.reset();
            p.input = input;
        }
    }

    /** Restore ordinary keyboard input when the controller is idle (so a human can still play). */
    public void releaseInput() {
        LocalPlayer p = mc.player;
        if (p != null && p.input == input) {
            input.reset();
            p.input = new net.minecraft.client.player.KeyboardInput(mc.options);
        }
    }

    /**
     * Propagate the controller's jump intent. {@code LivingEntity.aiStep} jumps off the
     * {@code jumping} field, which the local player sets from {@code input.jumping}; in
     * multiplayer that copy does not run, so we set it explicitly (a public API).
     */
    public void syncJump() {
        LocalPlayer p = mc.player;
        if (p != null && input.jumping) {
            p.setJumping(true);
        }
    }

    private LocalPlayer p() {
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null) {
            throw new IllegalStateException("no player in world");
        }
        return p;
    }

    // ---------------------------------------------------------------- helpers

    public static Item itemByName(String name) {
        if (name == null) {
            return null;
        }
        String n = name.contains(":") ? name : "minecraft:" + name;
        return BuiltInRegistries.ITEM.get(new ResourceLocation(n));
    }

    public static String itemName(ItemStack s) {
        ResourceLocation rl = BuiltInRegistries.ITEM.getKey(s.getItem());
        return rl == null ? "unknown" : rl.toString();
    }

    private static Block blockByName(String name) {
        String n = name.contains(":") ? name : "minecraft:" + name;
        return BuiltInRegistries.BLOCK.get(new ResourceLocation(n));
    }

    private static int invToMenuSlot(int invIndex) {
        if (invIndex < HOTBAR) {
            return 36 + invIndex;           // hotbar
        }
        if (invIndex < MAIN) {
            return invIndex;                // main inventory
        }
        if (invIndex < MAIN + 4) {
            return 5 + (invIndex - MAIN);   // armor
        }
        return 45;                          // offhand
    }

    private static String destToMenuSlot(String dest) {
        return dest == null ? "hand" : dest.toLowerCase(Locale.ROOT);
    }

    private int findInventorySlot(Item item) {
        Inventory inv = p().getInventory();
        for (int i = 0; i < MAIN; i++) {
            if (inv.getItem(i).is(item)) {
                return i;
            }
        }
        return -1;
    }

    private Entity entityById(int id) {
        return mc.level == null ? null : mc.level.getEntity(id);
    }

    private static BlockPos readPos(JsonObject args) {
        JsonArray a = args.getAsJsonArray("pos");
        return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
    }

    private static BlockPos readPos(JsonObject args, String key) {
        JsonArray a = args.getAsJsonArray(key);
        if (a == null || a.size() < 3) {
            return null;
        }
        return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
    }

    private static int optInt(JsonObject o, String k, int def) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsInt() : def;
    }

    private static long optLong(JsonObject o, String k, long def) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsLong() : def;
    }

    private static String optStr(JsonObject o, String k, String def) {
        return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : def;
    }

    // ---------------------------------------------------------------- movement (inline)

    public JsonObject lookAt(JsonObject args) {
        JsonArray a = args.getAsJsonArray("pos");
        Aim.look(p(), a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble());
        return Wire.accepted("looked");
    }

    public JsonObject respawn() {
        LocalPlayer p = mc.player;
        if (p != null && p.isDeadOrDying()) {
            p.respawn();
            mc.setScreen(null);
            return Wire.accepted("respawned");
        }
        return Wire.accepted("not dead");
    }

    public JsonObject stopMotion() {
        input.reset();
        LocalPlayer p = mc.player;
        if (p != null) {
            try {
                mc.gameMode.stopDestroyBlock();
            } catch (Throwable ignored) {
                // no-op
            }
            try {
                mc.gameMode.releaseUsingItem(p);
            } catch (Throwable ignored) {
                // no-op
            }
        }
        return Wire.accepted("motion stopped");
    }

    // ---------------------------------------------------------------- blocks (inline)

    public JsonObject place(JsonObject args) {
        LocalPlayer p = p();
        BlockPos pos = readPos(args);
        JsonArray f = args.getAsJsonArray("face");
        int fx = f == null ? 0 : f.get(0).getAsInt();
        int fy = f == null ? 1 : f.get(1).getAsInt();
        int fz = f == null ? 0 : f.get(2).getAsInt();
        String item = optStr(args, "item", null);
        if (item != null) {
            JsonObject eq = equipItem(item, "hand");
            if (!eq.get("accepted").getAsBoolean()) {
                return eq;
            }
        }
        BlockPos ref = pos.offset(-fx, -fy, -fz);
        Direction dir = Direction.fromDelta(fx, fy, fz);
        if (dir == null) {
            return Wire.rejected("invalid face");
        }
        Aim.look(p, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        Vec3 hitVec = new Vec3(ref.getX() + 0.5 + dir.getStepX() * 0.5,
                ref.getY() + 0.5 + dir.getStepY() * 0.5,
                ref.getZ() + 0.5 + dir.getStepZ() * 0.5);
        mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hitVec, dir, ref, false));
        p.swing(InteractionHand.MAIN_HAND);
        return Wire.accepted("place requested");
    }

    public JsonObject use(JsonObject args) {
        LocalPlayer p = p();
        BlockPos pos = readPos(args);
        Direction dir = faceTowards(p, pos);
        Aim.look(p, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        Vec3 hitVec = faceCenter(pos, dir);
        mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hitVec, dir, pos, false));
        p.swing(InteractionHand.MAIN_HAND);
        return Wire.accepted("used block");
    }

    public JsonObject useItemOn(JsonObject args) {
        LocalPlayer p = p();
        String item = optStr(args, "item", null);
        if (item != null) {
            JsonObject eq = equipItem(item, "hand");
            if (!eq.get("accepted").getAsBoolean()) {
                return eq;
            }
        }
        if (args.has("entityId")) {
            Entity e = entityById(args.get("entityId").getAsInt());
            if (e == null) {
                return Wire.rejected("entity not found");
            }
            mc.gameMode.interact(p, e, InteractionHand.MAIN_HAND);
            return Wire.accepted("used item on entity");
        }
        if (args.has("pos")) {
            BlockPos pos = readPos(args);
            Direction dir = faceTowards(p, pos);
            Aim.look(p, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
            mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND,
                    new BlockHitResult(faceCenter(pos, dir), dir, pos, false));
            p.swing(InteractionHand.MAIN_HAND);
            return Wire.accepted("used item on block");
        }
        return Wire.rejected("missing target");
    }

    public JsonObject interactEntity(JsonObject args) {
        LocalPlayer p = p();
        Entity e = entityById(args.get("entityId").getAsInt());
        if (e == null) {
            return Wire.rejected("entity not found");
        }
        String item = optStr(args, "item", null);
        if (item != null) {
            JsonObject eq = equipItem(item, "hand");
            if (!eq.get("accepted").getAsBoolean()) {
                return eq;
            }
        }
        mc.gameMode.interact(p, e, InteractionHand.MAIN_HAND);
        p.swing(InteractionHand.MAIN_HAND);
        return Wire.accepted("interacted");
    }

    // ---------------------------------------------------------------- inventory (inline)

    public JsonObject equip(JsonObject args) {
        return equipItem(optStr(args, "item", null), destToMenuSlot(optStr(args, "destination", "hand")));
    }

    /** Equip an item to hand / head / torso / legs / feet / off-hand. */
    public JsonObject equipItem(String name, String dest) {
        LocalPlayer p = p();
        Item item = itemByName(name);
        if (item == null) {
            return Wire.rejected("unknown item " + name);
        }
        Inventory inv = p.getInventory();
        if ("hand".equals(dest)) {
            if (p.getMainHandItem().is(item)) {
                return Wire.accepted("already held");
            }
            for (int i = 0; i < HOTBAR; i++) {
                if (inv.getItem(i).is(item)) {
                    inv.selected = i;
                    return Wire.accepted("equipped " + name);
                }
            }
            for (int i = HOTBAR; i < MAIN; i++) {
                if (inv.getItem(i).is(item)) {
                    click(0, i, inv.selected, ClickType.SWAP);
                    return Wire.accepted("equipped " + name);
                }
            }
            return Wire.rejected("item not in inventory: " + name);
        }
        int target = switch (dest) {
            case "head" -> 5;
            case "torso", "chest" -> 6;
            case "legs" -> 7;
            case "feet" -> 8;
            case "off-hand", "offhand" -> 45;
            default -> -1;
        };
        if (target < 0) {
            return Wire.rejected("unknown destination " + dest);
        }
        int src = findInventorySlot(item);
        if (src < 0) {
            return Wire.rejected("item not in inventory: " + name);
        }
        click(0, invToMenuSlot(src), 0, ClickType.QUICK_MOVE);
        return Wire.accepted("equipped " + name + " -> " + dest);
    }

    public JsonObject unequip(JsonObject args) {
        LocalPlayer p = p();
        String dest = destToMenuSlot(optStr(args, "destination", "hand"));
        int slot = switch (dest) {
            case "head" -> 5;
            case "torso", "chest" -> 6;
            case "legs" -> 7;
            case "feet" -> 8;
            case "off-hand", "offhand" -> 45;
            default -> -1;
        };
        if (slot < 0) {
            return Wire.rejected("unknown destination " + dest);
        }
        if (p.containerMenu.getSlot(slot).getItem().isEmpty()) {
            return Wire.accepted("nothing to unequip");
        }
        click(p.containerMenu.containerId, slot, 0, ClickType.QUICK_MOVE);
        return Wire.accepted("unequipped");
    }

    public JsonObject drop(JsonObject args) {
        LocalPlayer p = p();
        Item item = itemByName(optStr(args, "item", null));
        if (item == null) {
            return Wire.rejected("unknown item");
        }
        int count = Math.max(1, optInt(args, "count", 1));
        int src = findInventorySlot(item);
        if (src < 0) {
            return Wire.rejected("item not in inventory");
        }
        int menuSlot = invToMenuSlot(src);
        int have = p.getInventory().getItem(src).getCount();
        if (count >= have) {
            click(0, menuSlot, 1, ClickType.THROW);
        } else {
            for (int i = 0; i < count; i++) {
                click(0, menuSlot, 0, ClickType.THROW);
            }
        }
        return Wire.accepted("dropped " + count + " " + optStr(args, "item", ""));
    }

    public JsonObject closeContainer() {
        LocalPlayer p = mc.player;
        if (p == null) {
            return Wire.accepted("no player");
        }
        if (p.containerMenu.containerId != 0) {
            ((PlayerAccessor) p).mcagent$closeContainer();
        }
        mc.setScreen(null);
        return Wire.accepted("closed");
    }

    // ---------------------------------------------------------------- meta (inline)

    public JsonObject chat(JsonObject args) {
        p().connection.sendChat(optStr(args, "message", ""));
        return Wire.accepted("chat sent");
    }

    public JsonObject runCommand(JsonObject args) {
        String cmd = optStr(args, "command", "");
        if (!cmd.startsWith("/")) {
            cmd = "/" + cmd;
        }
        p().connection.sendCommand(cmd.substring(1));
        return Wire.accepted("command sent");
    }

    // ---------------------------------------------------------------- menu click

    private void click(int containerId, int slot, int button, ClickType type) {
        mc.gameMode.handleInventoryMouseClick(containerId, slot, button, type, p());
    }

    private static Direction faceTowards(LocalPlayer p, BlockPos pos) {
        Vec3 c = new Vec3(pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        Vec3 eye = p.getEyePosition();
        double dx = c.x - eye.x;
        double dy = c.y - eye.y;
        double dz = c.z - eye.z;
        return Direction.getNearest(dx, dy, dz);
    }

    private static Vec3 faceCenter(BlockPos pos, Direction dir) {
        return new Vec3(pos.getX() + 0.5 + dir.getStepX() * 0.5,
                pos.getY() + 0.5 + dir.getStepY() * 0.5,
                pos.getZ() + 0.5 + dir.getStepZ() * 0.5);
    }

    // ================================================================ tasks

    public ControlTask gotoTask(JsonObject args) {
        BlockPos goal = readPos(args);
        int range = optInt(args, "range", 1);
        long timeout = optLong(args, "timeoutMs", 15000);
        boolean allowModify = args.has("allowModify") && args.get("allowModify").getAsBoolean();
        return new WalkTask(mc, this, input, "goto", timeout + 2000,
                (pl, lv) -> goal, range, 0, allowModify);
    }

    public ControlTask followTask(JsonObject args) {
        int id = args.get("entityId").getAsInt();
        int distance = optInt(args, "distance", 2);
        long duration = optLong(args, "durationMs", 5000);
        long stopAt = System.currentTimeMillis() + duration;
        return new WalkTask(mc, this, input, "follow", duration + 3000, (pl, lv) -> {
            Entity e = entityById(id);
            return e == null ? null : e.blockPosition();
        }, distance, stopAt, false);
    }

    public ControlTask fleeTask(JsonObject args) {
        int id = args.get("entityId").getAsInt();
        int distance = Math.max(2, optInt(args, "distance", 8));
        long timeout = optLong(args, "timeoutMs", 15000);
        return new ControlTask("flee", timeout + 2000) {
            WalkTask inner;

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                Entity e = entityById(id);
                if (p == null || e == null) {
                    complete(Wire.rejected("entity not found"));
                    return true;
                }
                if (inner == null) {
                    double dx = p.getX() - e.getX();
                    double dz = p.getZ() - e.getZ();
                    double len = Math.max(0.001, Math.hypot(dx, dz));
                    BlockPos away = BlockPos.containing(p.getX() + dx / len * distance,
                            p.getY(), p.getZ() + dz / len * distance);
                    inner = new WalkTask(mc, PlayerActions.this, input, "flee", 12000, (pl, lv) -> away, 1, 0, false);
                }
                if (inner.step()) {
                    complete(inner.future().getNow(Wire.accepted("fled")));
                    return true;
                }
                return false;
            }

            @Override
            protected void onCancel() {
                input.reset();
            }
        };
    }

    public ControlTask waitTask(JsonObject args) {
        int ticks = Math.max(0, optInt(args, "ticks", 20));
        return new ControlTask("wait", ticks * 50L + 2000) {
            int n;

            @Override
            public boolean step() {
                if (++n >= ticks) {
                    complete(Wire.accepted("waited"));
                    return true;
                }
                return false;
            }
        };
    }

    public ControlTask steerTask(JsonObject args) {
        List<String> controls = new ArrayList<>();
        JsonArray arr = args.getAsJsonArray("controls");
        if (arr != null) {
            for (int i = 0; i < arr.size(); i++) {
                controls.add(arr.get(i).getAsString());
            }
        }
        long duration = optLong(args, "durationMs", 500);
        return new ControlTask("steer", duration + 2000) {
            long end = System.currentTimeMillis() + duration;

            @Override
            public boolean step() {
                input.move(controls.contains("forward") ? 1 : controls.contains("back") ? -1 : 0,
                        controls.contains("left") ? 1 : controls.contains("right") ? -1 : 0);
                input.jumping = controls.contains("jump");
                input.shiftKeyDown = controls.contains("sneak");
                if (System.currentTimeMillis() >= end) {
                    input.reset();
                    complete(Wire.accepted("steered"));
                    return true;
                }
                return false;
            }

            @Override
            protected void onCancel() {
                input.reset();
            }
        };
    }

    public ControlTask digTask(JsonObject args) {
        BlockPos pos = readPos(args);
        boolean breakThrough = !args.has("breakThrough") || args.get("breakThrough").getAsBoolean();
        return new ControlTask("dig", 20000) {
            final Digger digger = new Digger(mc);

            @Override
            public boolean autoProgress() {
                return false;
            }

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                ClientLevel level = mc.level;
                if (p == null || level == null) {
                    complete(Wire.rejected("no player"));
                    return true;
                }
                if (level.getBlockState(pos).isAir()) {
                    complete(Wire.accepted("dig completed"));
                    return true;
                }
                digger.setBreakThrough(breakThrough);
                digger.setOnBreak(this::noteBroken);
                digger.goal(pos);
                if (digger.tick(p, PlayerActions.this)) {
                    if (level.getBlockState(pos).isAir()) {
                        complete(Wire.accepted("dig completed"));
                    } else {
                        complete(Wire.rejected(digger.reason() != null ? digger.reason() : "dig failed"));
                    }
                    return true;
                }
                return false;
            }

            @Override
            protected void onCancel() {
                digger.stop();
            }
        };
    }

    void equipBestTool(BlockState st) {
        LocalPlayer p = mc.player;
        if (p == null) {
            return;
        }
        if (p.getMainHandItem().isCorrectToolForDrops(st)) {
            return;
        }
        Inventory inv = p.getInventory();
        for (int i = 0; i < MAIN; i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && s.isCorrectToolForDrops(st)) {
                equipItem(itemName(s), "hand");
                return;
            }
        }
    }

    public ControlTask attackTask(JsonObject args) {
        int id = args.get("entityId").getAsInt();
        long duration = optLong(args, "durationMs", 5000);
        String weapon = optStr(args, "weapon", null);
        return new ControlTask("attack", duration + 3000) {
            long end = System.currentTimeMillis() + duration;
            int cd;

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                Entity e = entityById(id);
                if (p == null) {
                    complete(Wire.rejected("no player"));
                    return true;
                }
                if (e == null) {
                    complete(Wire.accepted("attacked"));
                    return true;
                }
                if (System.currentTimeMillis() >= end) {
                    complete(Wire.accepted("attacked"));
                    return true;
                }
                if (weapon != null && cd == 0) {
                    equipItem(weapon, "hand");
                }
                if (++cd >= 10) {
                    cd = 0;
                    Aim.look(p, e.getX(), e.getEyeY(), e.getZ());
                    mc.gameMode.attack(p, e);
                    p.swing(InteractionHand.MAIN_HAND);
                }
                return false;
            }
        };
    }

    public ControlTask consumeTask(JsonObject args) {
        String item = optStr(args, "item", null);
        return new ControlTask("consume", 8000) {
            int n;

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                if (p == null) {
                    complete(Wire.rejected("no player"));
                    return true;
                }
                if (n == 0) {
                    if (item != null && !equipItem(item, "hand").get("accepted").getAsBoolean()) {
                        complete(Wire.rejected("cannot equip " + item));
                        return true;
                    }
                    mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);
                }
                n++;
                if (p.getUseItem().isEmpty() || n > 60) {
                    mc.gameMode.releaseUsingItem(p);
                    complete(Wire.accepted("consumed"));
                    return true;
                }
                return false;
            }

            @Override
            protected void onCancel() {
                LocalPlayer p = mc.player;
                if (p != null) {
                    mc.gameMode.releaseUsingItem(p);
                }
            }
        };
    }

    public ControlTask useItemTask(JsonObject args) {
        String item = optStr(args, "item", null);
        long release = optLong(args, "releaseMs", 1000);
        return new ControlTask("useItem", release + 3000) {
            long end = System.currentTimeMillis() + release;
            boolean started;

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                if (p == null) {
                    complete(Wire.rejected("no player"));
                    return true;
                }
                if (!started) {
                    if (item != null && !equipItem(item, "hand").get("accepted").getAsBoolean()) {
                        complete(Wire.rejected("cannot equip " + item));
                        return true;
                    }
                    mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);
                    started = true;
                }
                if (System.currentTimeMillis() >= end) {
                    mc.gameMode.releaseUsingItem(p);
                    complete(Wire.accepted("used item"));
                    return true;
                }
                return false;
            }

            @Override
            protected void onCancel() {
                LocalPlayer p = mc.player;
                if (p != null) {
                    mc.gameMode.releaseUsingItem(p);
                }
            }
        };
    }

    public ControlTask openContainerTask(JsonObject args) {
        BlockPos pos = readPos(args);
        return new ControlTask("openContainer", 8000) {
            int n;
            boolean clicked;

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                if (p == null) {
                    complete(Wire.rejected("no player"));
                    return true;
                }
                if (!clicked) {
                    Direction dir = faceTowards(p, pos);
                    Aim.look(p, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
                    mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND,
                            new BlockHitResult(faceCenter(pos, dir), dir, pos, false));
                    p.swing(InteractionHand.MAIN_HAND);
                    clicked = true;
                }
                n++;
                if (p.containerMenu.containerId != 0) {
                    complete(Wire.accepted("opened"));
                    return true;
                }
                if (n > 60) {
                    complete(Wire.rejected("container did not open"));
                    return true;
                }
                return false;
            }
        };
    }

    public ControlTask transferTask(JsonObject args) {
        String item = optStr(args, "item", null);
        int count = Math.max(1, optInt(args, "count", 1));
        String from = optStr(args, "from", "inventory");
        String to = optStr(args, "to", "container");
        BlockPos pos = args.has("pos") ? readPos(args) : null;
        return new ControlTask("transfer", 15000) {
            int phase;
            int n;

            @Override
            public boolean step() {
                LocalPlayer p = mc.player;
                if (p == null) {
                    complete(Wire.rejected("no player"));
                    return true;
                }
                Item target = itemByName(item);
                if (target == null) {
                    complete(Wire.rejected("unknown item"));
                    return true;
                }
                if (phase == 0) {
                    if (pos != null && p.containerMenu.containerId == 0) {
                        Direction dir = faceTowards(p, pos);
                        mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND,
                                new BlockHitResult(faceCenter(pos, dir), dir, pos, false));
                    }
                    phase = 1;
                    return false;
                }
                if (phase == 1) {
                    if (pos != null && p.containerMenu.containerId == 0) {
                        if (++n > 60) {
                            complete(Wire.rejected("container did not open"));
                            return true;
                        }
                        return false;
                    }
                    phase = 2;
                }
                // phase 2: move items
                AbstractContainerMenu menu = p.containerMenu;
                int src = findMenuSlot(menu, target, from);
                if (src < 0) {
                    complete(Wire.rejected("item not found in " + from));
                    return true;
                }
                click(menu.containerId, src, 0, ClickType.QUICK_MOVE);
                complete(Wire.accepted("transferred"));
                return true;
            }
        };
    }

    private int findMenuSlot(AbstractContainerMenu menu, Item item, String where) {
        boolean wantContainer = "container".equals(where);
        Inventory inv = p().getInventory();
        for (int i = 0; i < menu.slots.size(); i++) {
            boolean playerSide = menu.getSlot(i).container == inv;
            if (wantContainer == playerSide) {
                continue;
            }
            if (menu.getSlot(i).getItem().is(item)) {
                return i;
            }
        }
        return -1;
    }

    public ControlTask craftTask(JsonObject args) {
        String item = optStr(args, "item", null);
        int count = Math.max(1, optInt(args, "count", 1));
        BlockPos table = readPos(args, "tablePos");
        return new ProductionTasks.CraftTask(mc, this, item, count, table);
    }

    public ControlTask smeltTask(JsonObject args) {
        return new ProductionTasks.SmeltTask(mc, this, optStr(args, "item", null),
                Math.max(1, optInt(args, "count", 1)), optStr(args, "fuel", null),
                args.has("pos") ? readPos(args) : null);
    }

    public ControlTask enchantTask(JsonObject args) {
        return new ProductionTasks.EnchantTask(mc, this, optStr(args, "item", null),
                optInt(args, "choice", 0), args.has("pos") ? readPos(args) : null);
    }

    public ControlTask anvilTask(JsonObject args) {
        return new ProductionTasks.AnvilTask(mc, this, optStr(args, "item1", null), optStr(args, "item2", null),
                optStr(args, "name", null));
    }

    public ControlTask tradeTask(JsonObject args) {
        return new ProductionTasks.TradeTask(mc, this, args.get("entityId").getAsInt(),
                optInt(args, "index", 0), Math.max(1, optInt(args, "times", 1)));
    }

    public ControlTask containerContentsTask(JsonObject args) {
        return new ProductionTasks.ContainerReadTask(mc, this, readPos(args));
    }

    // package-private helpers used by task classes
    AbstractContainerMenu menu() {
        return mc.player == null ? null : mc.player.containerMenu;
    }

    void menuClick(int containerId, int slot, int button, ClickType type) {
        click(containerId, slot, button, type);
    }

    int inventoryMenuSlot(Item item) {
        int inv = findInventorySlot(item);
        return inv < 0 ? -1 : invToMenuSlot(inv);
    }

    Minecraft minecraft() {
        return mc;
    }

    boolean useOnBlock(BlockPos pos) {
        LocalPlayer p = mc.player;
        if (p == null) {
            return false;
        }
        Direction dir = faceTowards(p, pos);
        Aim.look(p, pos.getX() + 0.5, pos.getY() + 0.5, pos.getZ() + 0.5);
        mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND,
                new BlockHitResult(faceCenter(pos, dir), dir, pos, false));
        p.swing(InteractionHand.MAIN_HAND);
        return true;
    }

    BlockPos findNearbyBlock(String blockName, int radius) {
        Block block = blockByName(blockName);
        ClientLevel level = mc.level;
        LocalPlayer p = mc.player;
        if (block == null || level == null || p == null) {
            return null;
        }
        BlockPos origin = p.blockPosition();
        for (int r = 1; r <= radius; r++) {
            for (int dx = -r; dx <= r; dx++) {
                for (int dy = -r; dy <= r; dy++) {
                    for (int dz = -r; dz <= r; dz++) {
                        if (Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz))) != r) {
                            continue;
                        }
                        BlockPos pos = origin.offset(dx, dy, dz);
                        if (level.getBlockState(pos).is(block)) {
                            return pos;
                        }
                    }
                }
            }
        }
        return null;
    }

    List<Recipe<?>> craftingRecipes(Item result) {
        ClientLevel level = mc.level;
        if (level == null) {
            return List.of();
        }
        List<Recipe<?>> out = new ArrayList<>();
        for (Recipe<?> r : level.getRecipeManager().getAllRecipesFor(RecipeType.CRAFTING)) {
            if (r.getResultItem(level.registryAccess()).is(result)) {
                out.add(r);
            }
        }
        return out;
    }

    /** Menu slot (in the currently open menu) of the first inventory stack matching an ingredient. */
    int menuSlotForIngredient(Ingredient ing) {
        LocalPlayer p = p();
        Inventory inv = p.getInventory();
        int invIndex = -1;
        for (int i = 0; i < MAIN; i++) {
            ItemStack s = inv.getItem(i);
            if (!s.isEmpty() && ing.test(s)) {
                invIndex = i;
                break;
            }
        }
        if (invIndex < 0) {
            return -1;
        }
        // Locate the slot in the *currently open* menu by container identity + index; the player
        // inventory sits at different menu slots depending on the menu (2x2 vs 3x3 grid, etc.).
        AbstractContainerMenu menu = p.containerMenu;
        for (int i = 0; i < menu.slots.size(); i++) {
            Slot s = menu.getSlot(i);
            if (s.container == inv && s.getContainerSlot() == invIndex) {
                return i;
            }
        }
        return -1;
    }
}
