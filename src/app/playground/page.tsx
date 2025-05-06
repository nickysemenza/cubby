"use client";

import { useState } from "react";
import { CreateLocationDialog } from "../_components/combobox/with-search-hook";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { WithLocationSearch } from "../_components/combobox/with-search-hook";
import { DialogCompatibleCombobox } from "../_components/combobox/combobox-dialog";

const PlaygroundPage: React.FC = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(true);
  const [selectedItem, setSelectedItem] = useState<{
    id: string;
    name: string;
  } | null>(null);

  return (
    <div className="container mx-auto p-4">
      <h1 className="mb-4 text-2xl font-bold">Playground</h1>
      <div className="rounded-lg border p-4">
        <p>This is a playground page for testing components and features.</p>

        <div className="mt-4 flex flex-col gap-4">
          <Button onClick={() => setIsDialogOpen(true)} variant="outline">
            Open Dialog
          </Button>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Test Dialog with Combobox</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <p>This dialog has a combobox that should work correctly.</p>
                <WithLocationSearch>
                  {({ findItems, onCreateNew }) => (
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">
                        Select Location
                      </label>
                      <DialogCompatibleCombobox
                        label="location"
                        findItems={findItems}
                        value={selectedItem}
                        setValue={setSelectedItem}
                        onCreateNew={onCreateNew}
                      />
                    </div>
                  )}
                </WithLocationSearch>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
};

export default PlaygroundPage;
