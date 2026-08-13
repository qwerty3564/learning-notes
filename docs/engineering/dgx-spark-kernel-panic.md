# DGX Spark 更新后 Kernel Panic 无损修复笔记

## 一、故障背景

设备是一台 NVIDIA DGX Spark，故障发生在通过 DGX Dashboard 执行系统更新之后。更新完成并重启时，设备没有正常进入 DGX OS，而是直接出现 Kernel Panic，屏幕输出核心报错：

```text
KERNEL PANIC!
Please reboot your computer

VFS: Unable to mount root fs on unknown-block(0,0)
```

本机内部 SSD 为三星 NVMe（SAMSUNG MZALC4T0HBL1-00B07，约 4TB）。系统无法进入，首先要判断方向：是 SSD 硬件坏了，还是只是启动文件出了问题。前者基本只能走售后或重装，后者则可以通过 Live USB 无损修复。

## 二、故障定位：从报错看问题方向

Linux 正常启动流程是 UEFI → GRUB → Kernel → initramfs → 识别 NVMe → 挂载 root → 进入系统。本次实际只走到 Kernel 启动就报 "VFS: Unable to mount root fs"，说明 Kernel 本身已经运行起来，但在启动早期拿不到可用于挂载 `/` 的根块设备。

`unknown-block(0,0)` 表示 Kernel 没有找到可用的根设备。常见原因有几类：root 启动参数错误、initramfs 缺失或损坏、initramfs 里缺少 NVMe/ext4 驱动、Kernel 更新不完整、Kernel 与 initramfs 不匹配，极少数情况是 SSD 或控制器硬件故障。后续排查确认本次属于"新 Kernel 已安装，但对应 initramfs 没有生成"。

## 三、硬件排查：排除 SSD 整块损坏

动手改系统之前，先按"硬件 → 软件"的顺序确认 SSD 状态。三个检查结果都正常：

1. UEFI 里进入 Advanced → NVMe Configuration，能看到 SAMSUNG MZALC4T0HBL1-00B07（4096.8GB），说明 SSD 没有从硬件层面消失；
2. 在 UEFI 中执行 NVMe 自检（Self Test 选择 Short，Action 选择 Controller and Namespace Test），结果 Pass；
3. 用 Ubuntu ARM64 Live USB 启动后执行 `sudo lsblk -e 7 -o NAME,SIZE,FSTYPE,MOUNTPOINTS,MODEL`，能看到 nvme0n1p1（298M，vfat，EFI 分区）和 nvme0n1p2（3.7T，ext4，root 分区）。

其中 `lsblk -e 7` 是排除 loop 设备，让输出只保留真实块设备，更容易看清磁盘结构。再执行 `sudo blkid` 确认分区身份：`/dev/nvme0n1p1` 的 LABEL 是 EFI、TYPE 是 vfat；`/dev/nvme0n1p2` 的 LABEL 是 root、TYPE 是 ext4。到这里基本可以下结论：SSD 本身没坏，问题出在启动文件不完整。

## 四、根因确认：新 Kernel 缺对应 initramfs

用 Live 系统检查原系统的 `/boot` 目录。先创建挂载点并只读挂载 root 分区，避免误写：

```bash
sudo mkdir -p /mnt/spark
sudo mount -o ro /dev/nvme0n1p2 /mnt/spark
ls /mnt/spark
```

如果能正常看到 bin、boot、etc、home、usr、var 等目录，说明原系统还在，用户数据也没有丢。接着检查 Kernel 与 initramfs 是否成对：

```bash
ls -lh /mnt/spark/boot/vmlinuz-*
ls -lh /mnt/spark/boot/initrd.img-*
```

本机实际情况：vmlinuz 有三个版本（6.11.0-1014、6.17.0-1018、6.17.0-1029），而 initrd.img 只有两个（6.11.0-1014、6.17.0-1018），缺少 `initrd.img-6.17.0-1029-nvidia`。也就是说系统更新时装好了新内核 vmlinuz-6.17.0-1029-nvidia，但对应的 initramfs 没有生成成功。

initramfs 是 Kernel 启动早期的一个临时用户空间，负责加载 NVMe、ext4 等驱动，完成 root 设备初始化后再挂载真正的根文件系统。缺了它，Kernel 即使存在也无法完成根文件系统挂载，于是出现 VFS 报错并 panic，这正是本次故障的完整因果链。

## 五、无损修复：Live USB + chroot 重新生成 initramfs

由于设备无法可靠进入 GRUB 菜单选择旧内核，直接用 Ubuntu ARM64 Live USB 启动一个临时系统来完成修复，全程不重装、不格式化，原有数据和系统配置都保留。

### 5.1 制作 ARM64 启动盘并启动

DGX Spark 是 ARM64/aarch64 架构，所以必须下载 ARM64 版本的 Ubuntu Desktop ISO（如 ubuntu-26.04-desktop-arm64.iso），用 Rufus 写入 U 盘时选择 ISO Image mode。注意 Rufus 制作启动盘会清空 U 盘原有数据。如果 U 盘是 USB-A 接口而 DGX Spark 只有 USB-C 口，需要准备支持数据传输的 OTG 转接头（只有充电功能的不行）。

开机前插好 U 盘，开机后立即按 Esc 进入 UEFI，在 Save & Exit → Boot Override 里选择 `UEFI: USB Hard Drive, Partition 1`，不要选内部 SSD（显示为 ubuntu (SAMSUNG ...)），因为那正是会 Kernel Panic 的系统。进入 Ubuntu 启动菜单后选 Try Ubuntu 而不是 Install Ubuntu，进桌面后按 Ctrl+Alt+T 打开终端，先执行 `uname -m` 确认输出是 aarch64，保证 Live 系统架构正确。

### 5.2 重新挂载为读写并准备 chroot

确认磁盘结构（sda 是 U 盘，nvme0n1 是内部 SSD）后，先卸载只读挂载，再以读写方式重新挂载：

```bash
sudo umount /mnt/spark
sudo mount /dev/nvme0n1p2 /mnt/spark
mount | grep /mnt/spark
```

最后一条输出里应能看到 rw 而不是 ro，说明现在可以修改原系统。接下来把 Live 系统的虚拟文件系统映射进原系统，这样 chroot 之后执行的命令才会作用于内部 SSD 上的 DGX OS：

```bash
sudo mount --rbind /dev /mnt/spark/dev
sudo mount --make-rslave /mnt/spark/dev
sudo mount --rbind /proc /mnt/spark/proc
sudo mount --make-rslave /mnt/spark/proc
sudo mount --rbind /sys /mnt/spark/sys
sudo mount --make-rslave /mnt/spark/sys
sudo mount --rbind /run /mnt/spark/run
sudo mount --make-rslave /mnt/spark/run
sudo chroot /mnt/spark /bin/bash
```

`--rbind` 是递归绑定挂载，`--make-rslave` 保证挂载事件不会反向传播到宿主机，这是 chroot 修复环境的标准做法。进入后提示符变成 `root@ubuntu:/#`。

这里有一个非常典型的坑：如果只挂载了 /dev 和 /proc，漏掉 /sys 和 /run，执行 update-initramfs 时会报 `cryptsetup: ERROR: Couldn't find sysfs directory for 259:2`。原因在于 initramfs 生成脚本需要通过 /sys 查询块设备与 NVMe 信息，而普通 chroot 不会自动把 sysfs 带进去。遇到这个报错，先 `exit` 退出 chroot，补挂 /sys 和 /run 后再重新 chroot，可用 `ls -ld /sys/dev/block/259:2` 确认能正确指向 nvme0n1/nvme0n1p2 后继续。

### 5.3 生成缺失的 initramfs 并更新 GRUB

先确认模块目录存在，说明对应 Kernel 的模块文件仍然完整：

```bash
ls -ld /lib/modules/6.17.0-1029-nvidia
```

然后生成缺失的 initramfs：

```bash
update-initramfs -c -k 6.17.0-1029-nvidia
```

`-c` 表示强制重新生成，`-k` 指定内核版本。正常输出会出现 `Generating /boot/initrd.img-6.17.0-1029-nvidia`，之后用 `ls -lh /boot/initrd.img-6.17.0-1029-nvidia` 确认文件已生成（本机约 81M）。

接着更新 GRUB 配置，让启动菜单记录新的内核与 initramfs：

```bash
update-grub
```

输出中应能找到 vmlinuz-6.17.0-1029-nvidia 和 initrd.img-6.17.0-1029-nvidia，同时旧的 6.17.0-1018、6.11.0-1014 也会被保留。如果出现 `Warning: os-prober will not be executed...`，与本次故障无关，可以忽略。

### 5.4 安全退出并重启验证

```bash
exit
sync
sudo umount -R /mnt/spark
sudo poweroff
```

`sync` 确保数据写回 SSD，`umount -R` 递归卸载所有映射，等设备完全关机后拔掉 U 盘再开机。这次不要进 UEFI、不要 Boot Override，让设备直接从内部 SSD 启动。正常启动链恢复为 UEFI → GRUB → vmlinuz-6.17.0-1029 → initrd.img-6.17.0-1029 → 识别 NVMe → 挂载 /dev/nvme0n1p2 → 进入 DGX OS。

整个修复真正起作用的其实只有两条命令：`update-initramfs -c -k 6.17.0-1029-nvidia` 和 `update-grub`。但它们必须在正确挂载原 root、映射 /dev /proc /sys /run、chroot 进原系统之后执行，直接在 Live 环境外面跑没有任何效果。

## 六、为什么不用 System Recovery / 重装

本次 SSD 在 UEFI 里可识别、NVMe 自检通过、root 分区可挂载、用户数据完整，说明既不是硬件故障，也没有文件系统损坏的证据，完全没必要重装或走恢复流程。优先用 Live USB 修复启动文件更安全，能保留全部数据。

## 七、Dashboard 更新问题分析与后续建议

故障链路是 DGX Dashboard → System Update → 重启 → Kernel Panic，最终状态是"新内核已安装、对应 initramfs 缺失"。但仅凭现状还不能断言 Dashboard 某个组件一定有 Bug；要查清 initramfs 为什么没生成，需要进一步看 dpkg 状态、DKMS 状态、Kernel post-install 日志、`/var/log/apt/`、`/var/log/dpkg.log` 以及 journalctl 中更新前后的相关记录。

后续维护建议：

1. 系统修复后先验证正常开机、重启、关机、GPU/CUDA、网络、Docker 都正常，再考虑下一次更新；
2. 以后只要涉及 Kernel 更新，重启前先检查 initramfs 是否成对。可以在重启前跑一段脚本遍历 /boot/vmlinuz-*，检查每个版本是否有对应的 initrd.img-*，出现 MISSING 就先不要重启，查清为什么 initramfs 没生成；
3. 用 `dpkg --audit` 和 `dpkg -l | grep 6.17.0-1029` 检查包状态，如果出现 half-installed、unpacked but not configured、iF 等状态，说明更新没有完整结束，先解决包状态问题再重启；
4. 暂时保留旧内核（6.11.0-1014、6.17.0-1018），万一新内核再出问题，旧内核是非常重要的救援入口。

另外，本次 Esc、Shift、F4、Shift+Insert 都无法可靠进入 GRUB 菜单，系统稳定后可以考虑让 GRUB 菜单显示几秒。先执行 `cat /etc/default/grub` 和 `ls -l /etc/default/grub.d/` 确认是否存在 NVIDIA/DGX 的厂商配置，确认可改后再设置 `GRUB_TIMEOUT_STYLE=menu` 和 `GRUB_TIMEOUT=5`，最后 `sudo update-grub`。修改前检查 grub.d 目录，是为了避免覆盖 DGX Spark 的特殊启动策略。

## 八、同类故障的快速排查清单

以后再看到 `VFS: Unable to mount root fs on unknown-block(0,0)`，按这个顺序排查：UEFI 能否看到 NVMe → NVMe 自检是否通过 → Live USB 能否看到 root 分区 → root 能否只读挂载 → /boot 里 vmlinuz 与 initrd.img 是否成对 → 若新内核缺 initrd，chroot 后执行 update-initramfs → update-grub → 安全卸载、关机、拔 U 盘 → 正常启动。

## 九、不推荐的操作

遇到这类故障不要一上来就做高风险操作：不要直接重装系统（SSD 可识别、root 可挂载、数据还在时优先修启动链）；不要格式化或删除内部 NVMe 分区（mkfs、fdisk、parted 都要避免）；不要对已挂载的 root 直接 fsck（确有需要应在未挂载状态下进行，本次没有证据表明 ext4 损坏）；不要无依据执行 grub-install（本次 UEFI/GRUB 本身能加载内核，问题只是 Kernel 有、initramfs 缺）。

## 一句话总结

> **DGX Spark 在 Dashboard 更新后，新 NVIDIA Kernel（6.17.0-1029-nvidia）已安装但对应 initramfs 未生成，导致重启后无法挂载 root filesystem，触发 `VFS: Unable to mount root fs on unknown-block(0,0)`；最终通过 ARM64 Ubuntu Live USB 挂载原系统，在 chroot 环境中重新生成 initramfs 并执行 update-grub 完成无损修复。**
