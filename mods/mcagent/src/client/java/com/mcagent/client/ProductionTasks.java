package com.mcagent.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.EnchantmentMenu;
import net.minecraft.world.inventory.MerchantMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.ShapedRecipe;

import java.util.ArrayDeque;
import java.util.List;

/**
 * Multi-tick production / container primitives (craft / smelt / enchant / anvil / trade /
 * container read). They drive the vanilla menus with ordinary slot clicks and buttons, one
 * click per tick to stay in sync with the server.
 */
final class ProductionTasks {

    private ProductionTasks() {}

    /** Base for tasks that drive a container menu. */
    abstract static class MenuTask extends ControlTask {
        protected final Minecraft mc;
        protected final PlayerActions a;
        private int wait;
        private final ArrayDeque<Runnable> queue = new ArrayDeque<>();

        MenuTask(Minecraft mc, PlayerActions a, String label, long budget) {
            super(label, budget);
            this.mc = mc;
            this.a = a;
        }

        protected void delay(int ticks) {
            wait = Math.max(wait, ticks);
        }

        protected void enqueue(Runnable r) {
            queue.add(r);
        }

        /** Returns true if this tick was consumed by a delay or a queued click. */
        protected boolean pump() {
            if (wait > 0) {
                wait--;
                return true;
            }
            if (!queue.isEmpty()) {
                queue.poll().run();
                delay(1);
                return true;
            }
            return false;
        }

        protected LocalPlayer p() {
            return mc.player;
        }

        protected AbstractContainerMenu menu() {
            return mc.player == null ? null : mc.player.containerMenu;
        }

        protected void click(int slot, int button, ClickType type) {
            a.menuClick(menu().containerId, slot, button, type);
        }

        protected void moveStack(int fromSlot, int toSlot) {
            // Space the two clicks one per tick: same-tick multi-clicks desync the server.
            enqueue(() -> click(fromSlot, 0, ClickType.PICKUP));
            enqueue(() -> click(toSlot, 0, ClickType.PICKUP));
        }
    }

    // ------------------------------------------------------------------ craft

    static final class CraftTask extends MenuTask {
        private final String item;
        private final int count;
        private final BlockPos table;
        private Recipe<?> recipe;
        private Item target;
        private int gridWidth = 2;
        private int produced;
        private int resultCount = 1;
        private int phase;
        private int waited;

        CraftTask(Minecraft mc, PlayerActions a, String item, int count, BlockPos table) {
            super(mc, a, "craft", 40000);
            this.item = item;
            this.count = count;
            this.table = table;
        }

        @Override
        public boolean step() {
            if (pump()) {
                return false;
            }
            LocalPlayer p = p();
            ClientLevel level = mc.level;
            if (p == null || level == null) {
                complete(Wire.rejected("no player"));
                return true;
            }
            if (recipe == null) {
                target = PlayerActions.itemByName(item);
                if (target == null) {
                    complete(Wire.rejected("unknown item " + item));
                    return true;
                }
                gridWidth = table != null ? 3 : 2;
                List<Recipe<?>> recipes = a.craftingRecipes(target);
                recipe = pickSatisfiable(recipes);
                if (recipe == null) {
                    complete(Wire.rejected(recipes.isEmpty() ? "no recipe for " + item : "missing ingredients for " + item));
                    return true;
                }
                resultCount = Math.max(1, recipe.getResultItem(level.registryAccess()).getCount());
                if (table != null) {
                    a.useOnBlock(table);
                    phase = 1;
                    waited = 0;
                    delay(2);
                    return false;
                }
                phase = 2;
            }
            switch (phase) {
                case 1: {
                    AbstractContainerMenu m = menu();
                    if (m != null && m.containerId != 0) {
                        phase = 2;
                    } else if (++waited > 60) {
                        complete(Wire.rejected("crafting table did not open"));
                        return true;
                    }
                    return false;
                }
                case 2: {
                    if (!buildPlacement()) {
                        complete(Wire.rejected("cannot place ingredients"));
                        return true;
                    }
                    phase = 3;
                    return false;
                }
                case 3: {
                    delay(3);
                    phase = 4;
                    waited = 0;
                    return false;
                }
                case 4: {
                    AbstractContainerMenu m = menu();
                    if (m != null && m.getSlot(0).getItem().is(target)) {
                        enqueue(() -> click(0, 0, ClickType.QUICK_MOVE));
                        phase = 5;
                    } else if (++waited > 40) {
                        complete(Wire.rejected("no crafting result"));
                        return true;
                    }
                    return false;
                }
                case 5: {
                    produced += resultCount;
                    if (produced >= count) {
                        complete(Wire.accepted("crafted"));
                        return true;
                    }
                    phase = 2;
                    return false;
                }
                default:
                    complete(Wire.rejected("craft failed"));
                    return true;
            }
        }

        /** First recipe whose non-empty ingredients the inventory can satisfy and fits the grid. */
        private Recipe<?> pickSatisfiable(List<Recipe<?>> recipes) {
            for (Recipe<?> r : recipes) {
                if (r instanceof ShapedRecipe sr && (sr.getWidth() > gridWidth || sr.getHeight() > gridWidth)) {
                    continue;
                }
                boolean ok = true;
                for (Ingredient ing : r.getIngredients()) {
                    if (ing.getItems().length == 0) {
                        continue;
                    }
                    if (a.menuSlotForIngredient(ing) < 0) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    return r;
                }
            }
            return null;
        }

        /** Enqueue the clicks that fill the crafting grid (one click per tick). */
        private boolean buildPlacement() {
            List<Ingredient> ings = recipe.getIngredients();
            int cells = gridWidth * gridWidth;
            int[] map = new int[cells];
            java.util.Arrays.fill(map, -1);
            if (recipe instanceof ShapedRecipe sr) {
                int w = sr.getWidth();
                int h = sr.getHeight();
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        int idx = y * w + x;
                        if (idx < ings.size()) {
                            map[y * gridWidth + x] = idx;
                        }
                    }
                }
            } else {
                for (int i = 0; i < Math.min(ings.size(), cells); i++) {
                    map[i] = i;
                }
            }
            for (int gi = 0; gi < cells; gi++) {
                int ing = map[gi];
                if (ing < 0 || ing >= ings.size()) {
                    continue;
                }
                Ingredient ingredient = ings.get(ing);
                if (ingredient.getItems().length == 0) {
                    continue;
                }
                int slot = a.menuSlotForIngredient(ingredient);
                if (slot < 0) {
                    return false;
                }
                final int gridSlot = 1 + gi;
                enqueue(() -> click(slot, 0, ClickType.PICKUP));
                enqueue(() -> click(gridSlot, 1, ClickType.PICKUP));
                enqueue(() -> click(slot, 0, ClickType.PICKUP));
            }
            return true;
        }
    }

    // ------------------------------------------------------------------ smelt

    static final class SmeltTask extends MenuTask {
        private final String item;
        private final int count;
        private final String fuel;
        private final BlockPos pos;
        private Item target;
        private int phase;
        private int waited;

        SmeltTask(Minecraft mc, PlayerActions a, String item, int count, String fuel, BlockPos pos) {
            super(mc, a, "smelt", 60000);
            this.item = item;
            this.count = count;
            this.fuel = fuel;
            this.pos = pos;
        }

        @Override
        public boolean step() {
            if (pump()) {
                return false;
            }
            LocalPlayer p = p();
            if (p == null) {
                complete(Wire.rejected("no player"));
                return true;
            }
            target = PlayerActions.itemByName(item);
            if (target == null) {
                complete(Wire.rejected("unknown item " + item));
                return true;
            }
            switch (phase) {
                case 0: {
                    BlockPos furnace = pos != null ? pos : a.findNearbyBlock("furnace", 8);
                    if (furnace == null) {
                        complete(Wire.rejected("no furnace nearby"));
                        return true;
                    }
                    a.useOnBlock(furnace);
                    phase = 1;
                    delay(2);
                    return false;
                }
                case 1: {
                    AbstractContainerMenu m = menu();
                    if (m == null || m.containerId == 0) {
                        if (++waited > 60) {
                            complete(Wire.rejected("furnace did not open"));
                            return true;
                        }
                        return false;
                    }
                    int inv = a.inventoryMenuSlot(target);
                    if (inv < 0) {
                        complete(Wire.rejected("item not in inventory"));
                        return true;
                    }
                    moveStack(inv, 0); // input
                    if (fuel != null) {
                        Item fuelItem = PlayerActions.itemByName(fuel);
                        int fuelInv = fuelItem == null ? -1 : a.inventoryMenuSlot(fuelItem);
                        if (fuelInv >= 0) {
                            moveStack(fuelInv, 1);
                        }
                    }
                    phase = 2;
                    return false;
                }
                case 2: {
                    AbstractContainerMenu m = menu();
                    if (m != null && m.getSlot(2).getItem().is(target)) {
                        click(2, 0, ClickType.QUICK_MOVE);
                        complete(Wire.accepted("smelted"));
                        return true;
                    }
                    if (++waited > 400) {
                        complete(Wire.rejected("smelt timeout"));
                        return true;
                    }
                    return false;
                }
                default:
                    complete(Wire.rejected("smelt failed"));
                    return true;
            }
        }
    }

    // ------------------------------------------------------------------ enchant

    static final class EnchantTask extends MenuTask {
        private final String item;
        private final int choice;
        private final BlockPos pos;
        private int phase;
        private int waited;

        EnchantTask(Minecraft mc, PlayerActions a, String item, int choice, BlockPos pos) {
            super(mc, a, "enchant", 30000);
            this.item = item;
            this.choice = choice;
            this.pos = pos;
        }

        @Override
        public boolean step() {
            if (pump()) {
                return false;
            }
            LocalPlayer p = p();
            if (p == null) {
                complete(Wire.rejected("no player"));
                return true;
            }
            Item target = PlayerActions.itemByName(item);
            switch (phase) {
                case 0: {
                    BlockPos table = pos != null ? pos : a.findNearbyBlock("enchanting_table", 8);
                    if (table == null) {
                        complete(Wire.rejected("no enchanting table nearby"));
                        return true;
                    }
                    a.useOnBlock(table);
                    phase = 1;
                    delay(2);
                    return false;
                }
                case 1: {
                    AbstractContainerMenu m = menu();
                    if (m == null || m.containerId == 0) {
                        if (++waited > 60) {
                            complete(Wire.rejected("enchanting table did not open"));
                            return true;
                        }
                        return false;
                    }
                    int inv = target == null ? -1 : a.inventoryMenuSlot(target);
                    if (inv < 0) {
                        complete(Wire.rejected("item not in inventory"));
                        return true;
                    }
                    moveStack(inv, 0);
                    phase = 2;
                    delay(3);
                    return false;
                }
                case 2: {
                    AbstractContainerMenu m = menu();
                    if (m instanceof EnchantmentMenu em) {
                        mc.gameMode.handleInventoryButtonClick(em.containerId, choice);
                    }
                    phase = 3;
                    delay(10);
                    return false;
                }
                case 3: {
                    click(0, 0, ClickType.QUICK_MOVE);
                    complete(Wire.accepted("enchanted"));
                    return true;
                }
                default:
                    complete(Wire.rejected("enchant failed"));
                    return true;
            }
        }
    }

    // ------------------------------------------------------------------ anvil

    static final class AnvilTask extends MenuTask {
        private final String item1;
        private final String item2;
        private final String name;
        private int phase;
        private int waited;

        AnvilTask(Minecraft mc, PlayerActions a, String item1, String item2, String name) {
            super(mc, a, "anvilCombine", 30000);
            this.item1 = item1;
            this.item2 = item2;
            this.name = name;
        }

        @Override
        public boolean step() {
            if (pump()) {
                return false;
            }
            LocalPlayer p = p();
            if (p == null) {
                complete(Wire.rejected("no player"));
                return true;
            }
            switch (phase) {
                case 0: {
                    BlockPos anvil = a.findNearbyBlock("anvil", 8);
                    if (anvil == null) {
                        complete(Wire.rejected("no anvil nearby"));
                        return true;
                    }
                    a.useOnBlock(anvil);
                    phase = 1;
                    delay(2);
                    return false;
                }
                case 1: {
                    AbstractContainerMenu m = menu();
                    if (m == null || m.containerId == 0) {
                        if (++waited > 60) {
                            complete(Wire.rejected("anvil did not open"));
                            return true;
                        }
                        return false;
                    }
                    Item i1 = PlayerActions.itemByName(item1);
                    Item i2 = PlayerActions.itemByName(item2);
                    int s1 = i1 == null ? -1 : a.inventoryMenuSlot(i1);
                    int s2 = i2 == null ? -1 : a.inventoryMenuSlot(i2);
                    if (s1 < 0 || s2 < 0) {
                        complete(Wire.rejected("items not in inventory"));
                        return true;
                    }
                    moveStack(s1, 0);
                    moveStack(s2, 1);
                    phase = 2;
                    delay(2);
                    return false;
                }
                case 2: {
                    AbstractContainerMenu m = menu();
                    if (name != null && m instanceof AnvilMenu am) {
                        am.setItemName(name);
                    }
                    phase = 3;
                    delay(5);
                    return false;
                }
                case 3: {
                    click(2, 0, ClickType.QUICK_MOVE);
                    complete(Wire.accepted("combined"));
                    return true;
                }
                default:
                    complete(Wire.rejected("anvil failed"));
                    return true;
            }
        }
    }

    // ------------------------------------------------------------------ trade

    static final class TradeTask extends MenuTask {
        private final int entityId;
        private final int index;
        private final int times;
        private int phase;
        private int done;
        private int waited;

        TradeTask(Minecraft mc, PlayerActions a, int entityId, int index, int times) {
            super(mc, a, "trade", 30000);
            this.entityId = entityId;
            this.index = index;
            this.times = times;
        }

        @Override
        public boolean step() {
            if (pump()) {
                return false;
            }
            LocalPlayer p = p();
            if (p == null) {
                complete(Wire.rejected("no player"));
                return true;
            }
            Entity e = mc.level == null ? null : mc.level.getEntity(entityId);
            switch (phase) {
                case 0: {
                    if (e == null) {
                        complete(Wire.rejected("entity not found"));
                        return true;
                    }
                    mc.gameMode.interact(p, e, net.minecraft.world.InteractionHand.MAIN_HAND);
                    phase = 1;
                    delay(2);
                    return false;
                }
                case 1: {
                    AbstractContainerMenu m = menu();
                    if (m instanceof MerchantMenu mm) {
                        mm.setSelectionHint(index);
                        mm.tryMoveItems(index);
                        phase = 2;
                        delay(5);
                        return false;
                    }
                    if (++waited > 60) {
                        complete(Wire.rejected("merchant did not open"));
                        return true;
                    }
                    return false;
                }
                case 2: {
                    click(2, 0, ClickType.QUICK_MOVE);
                    done++;
                    if (done >= times) {
                        complete(Wire.accepted("traded"));
                        return true;
                    }
                    phase = 1;
                    delay(3);
                    return false;
                }
                default:
                    complete(Wire.rejected("trade failed"));
                    return true;
            }
        }
    }

    // ------------------------------------------------------------------ container read

    static final class ContainerReadTask extends MenuTask {
        private final BlockPos pos;
        private int phase;
        private int waited;

        ContainerReadTask(Minecraft mc, PlayerActions a, BlockPos pos) {
            super(mc, a, "containerContents", 10000);
            this.pos = pos;
        }

        @Override
        public boolean step() {
            if (pump()) {
                return false;
            }
            LocalPlayer p = p();
            if (p == null) {
                complete(Wire.rejected("no player"));
                return true;
            }
            switch (phase) {
                case 0: {
                    a.useOnBlock(pos);
                    phase = 1;
                    delay(2);
                    return false;
                }
                case 1: {
                    AbstractContainerMenu m = menu();
                    if (m == null || m.containerId == 0) {
                        if (++waited > 60) {
                            complete(Wire.rejected("container did not open"));
                            return true;
                        }
                        return false;
                    }
                    JsonArray arr = new JsonArray();
                    var inv = p.getInventory();
                    for (int i = 0; i < m.slots.size(); i++) {
                        if (m.getSlot(i).container == inv) {
                            continue;
                        }
                        ItemStack s = m.getSlot(i).getItem();
                        if (s.isEmpty()) {
                            continue;
                        }
                        JsonObject it = new JsonObject();
                        it.addProperty("slot", i);
                        it.addProperty("item", PlayerActions.itemName(s));
                        it.addProperty("count", s.getCount());
                        arr.add(it);
                    }
                    ((com.mcagent.client.mixin.PlayerAccessor) p).mcagent$closeContainer();
                    complete(Wire.result(arr));
                    return true;
                }
                default:
                    complete(Wire.rejected("container read failed"));
                    return true;
            }
        }
    }
}
